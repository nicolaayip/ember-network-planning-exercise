/**
 * Step 10 — VEHICLES & CHARGING (pipeline step 10).
 *
 * 1. Compute return-trip distance (Google legs or great-circle fallback) and energy scenarios.
 * 2. Enrich proposed timetable columns: drivers' hours, dead-leg checks, modelled arrivals.
 * 3. Schedule blocks per energy scenario → vehicles required, cable use, and Gantt grid.
 * 4. Write doc.fleet including recharge time by cable configuration and break-even consumption.
 *
 * @format
 */

import { coachLegMin } from "../domain/coach-carriageway.js";
import { haversineMetres } from "../lib/geo.js";
import { parseHHMM, formatHHMM } from "../lib/time.js";
import { isDepot, passengerStops } from "../domain/document.js";
import { bandFor, weekdayBands } from "../domain/traffic-bands.js";
import { energyScenarios, breakEvenKwhPerKm, FULL_SOC } from "../domain/energy.js";
import { chargeTimeByCables } from "../domain/charging.js";
import { checkColumn } from "../domain/drivers-hours.js";
import { scheduleBlocks } from "../domain/block-scheduler.js";
import { round1, round3 } from "../lib/round.js";

export const name = "vehicles";

const WINDING_FACTOR = 1.1;

function pathKm(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += haversineMetres(points[i - 1], points[i]);
  return m / 1000;
}

function tripDistance(ctx) {
  const { document: doc, input } = ctx;
  const dirs = doc.directions;
  const deadLegs = {
    outbound: dirs.outbound.legs?.filter((l) => l.deadLeg) ?? [],
    return: dirs.return.legs?.filter((l) => l.deadLeg) ?? [],
  };
  if (dirs.outbound.legs?.length && dirs.return.legs?.length) {
    const paxKm = (d) =>
      dirs[d].legs.filter((l) => !l.deadLeg).reduce((s, l) => s + l.distanceKm, 0);
    return {
      oneWay: { outbound: paxKm("outbound"), return: paxKm("return") },
      deadKm: [...deadLegs.outbound, ...deadLegs.return].reduce((s, l) => s + l.distanceKm, 0),
      deadLegs,
      source: "google-routes",
    };
  }
  const pax = (d) => passengerStops(dirs[d]).map((s) => s.coordinates);
  const depotOut =
    dirs.outbound.orderedStops.find(isDepot)?.coordinates ?? input.depot?.coordinates;
  const depotRet =
    dirs.return.orderedStops.find(isDepot)?.coordinates ?? input.depot?.coordinates;
  return {
    oneWay: {
      outbound: pathKm(pax("outbound")) * WINDING_FACTOR,
      return: pathKm(pax("return")) * WINDING_FACTOR,
    },
    deadKm:
      (((depotOut ? haversineMetres(depotOut, pax("outbound")[0]) : 0) +
        (depotRet ? haversineMetres(pax("return").at(-1), depotRet) : 0)) /
        1000) *
      WINDING_FACTOR,
    deadLegs,
    source: `great-circle x ${WINDING_FACTOR} winding factor (placeholder until Google Routes)`,
  };
}

function deadLegCheck(col, key, leg, allowance, atMin, bands, coachFactorCentral) {
  if (!leg || allowance === undefined) return undefined;
  const bandId = bandFor(atMin, bands);
  const factor = leg.coachSpeedFactor ?? coachFactorCentral;
  const routedMin = round1(coachLegMin(leg.windows[bandId], factor));
  col.deadLegs[key] = {
    allowanceMin: allowance,
    routedMin,
    band: bandId,
    distanceKm: leg.distanceKm,
    slackMin: round1(allowance - routedMin),
  };
  return allowance >= routedMin;
}

/** Stamp drivers' hours, dead-leg checks, and return a schedule column — or null to skip. */
function enrichColumn(col, i, env) {
  const { log, fleet, energy, deadLegs, windows, lastOut, lastRet, depotOutStop, depotRetStop, coachFactorCentral } = env;
  const outArr = lastOut.proposedTimes?.[i];
  const retArr = lastRet.proposedTimes?.[i];
  if (outArr === undefined || retArr === undefined) {
    log.warn({ column: col.columnId }, "no proposed arrival times for column; skipping drivers' hours and scheduling");
    return null;
  }

  const depotDep = col.depotDeparture ?? depotOutStop?.proposedTimes?.[i];
  const depotArr = col.depotArrival ?? depotRetStop?.proposedTimes?.[i];
  const minutes = {
    depotDeparture: depotDep ? parseHHMM(depotDep) : undefined,
    outboundDeparture: parseHHMM(col.outboundDeparture),
    outboundArrival: parseHHMM(outArr),
    returnDeparture: parseHHMM(col.returnDeparture),
    returnArrival: parseHHMM(retArr),
    depotArrival: depotArr ? parseHHMM(depotArr) : undefined,
  };
  const dh = checkColumn(minutes, fleet.driversHours);

  col.outboundArrival = outArr;
  col.returnArrival = retArr;
  if (depotDep && !col.depotDeparture) col.depotDeparture = depotDep;
  if (depotArr && !col.depotArrival) col.depotArrival = depotArr;
  col.layoverMinutes = dh.layoverMinutes;
  col.driving = {
    outboundDrivingMinutes: dh.outboundDrivingMinutes,
    returnDrivingMinutes: dh.returnDrivingMinutes,
    dailyDrivingMinutes: dh.dailyDrivingMinutes,
    dutyMinutes: dh.dutyMinutes,
    layoverSlackMinutes: dh.layoverSlackMinutes,
    continuousWorkingMinutes: dh.continuousWorkingMinutes,
  };

  col.deadLegs = {};
  const allowanceOut =
    minutes.depotDeparture !== undefined
      ? minutes.outboundDeparture - minutes.depotDeparture
      : undefined;
  const allowanceIn =
    minutes.depotArrival !== undefined ? minutes.depotArrival - minutes.returnArrival : undefined;
  const deadOutOk = deadLegCheck(
    col,
    "toFirstStop",
    deadLegs.outbound[0],
    allowanceOut,
    minutes.depotDeparture,
    weekdayBands(windows, "outbound"),
    coachFactorCentral,
  );
  const deadInOk = deadLegCheck(
    col,
    "fromLastStop",
    deadLegs.return.at(-1),
    allowanceIn,
    minutes.returnArrival,
    weekdayBands(windows, "return"),
    coachFactorCentral,
  );
  col.checks = {
    ...dh.checks,
    ...(deadOutOk !== undefined ? { depotToFirstStopAllowanceSufficient: deadOutOk } : {}),
    ...(deadInOk !== undefined ? { lastStopToDepotAllowanceSufficient: deadInOk } : {}),
    socOnReturnAboveFloor: energy.central.feasible,
  };
  if (deadOutOk === false || deadInOk === false) {
    log.warn({ column: col.columnId, deadLegs: col.deadLegs }, "dead-leg allowance shorter than routed time");
  }

  return {
    columnId: col.columnId,
    depotDeparture: minutes.depotDeparture ?? minutes.outboundDeparture,
    depotArrival: minutes.depotArrival ?? minutes.returnArrival,
  };
}

export async function run(ctx) {
  const { document: doc, config, log } = ctx;
  const fleet = config.fleet;
  const { oneWay, deadKm, deadLegs, source } = tripDistance(ctx);
  const returnTripKm = oneWay.outbound + oneWay.return;

  const base = {
    returnTripKm,
    deadKm,
    depotToChargerKm: fleet.depotToChargerKm * 2,
    vehicle: fleet.vehicle,
  };
  const energy = energyScenarios(base, fleet.consumptionKwhPerKm);
  const breakEven = breakEvenKwhPerKm(base);

  const centralSoc = Math.max(fleet.vehicle.socFloor, energy.central.socOnReturn);
  const charging = chargeTimeByCables({
    socFrom: centralSoc,
    socTo: FULL_SOC,
    site: fleet.site,
    vehicle: fleet.vehicle,
  });

  const dirs = doc.directions;
  const enrichEnv = {
    log,
    fleet,
    energy,
    deadLegs,
    windows: doc.estimatedTemporalWindows,
    lastOut: passengerStops(dirs.outbound).at(-1),
    lastRet: passengerStops(dirs.return).at(-1),
    depotOutStop: dirs.outbound.orderedStops.find(isDepot),
    depotRetStop: dirs.return.orderedStops.find(isDepot),
    coachFactorCentral: config.engine.coachTimeFactor.central,
  };
  const scheduled = doc.timetableColumns
    .map((col, i) => enrichColumn(col, i, enrichEnv))
    .filter(Boolean);

  const scenarios = {};
  for (const [nameKey, e] of Object.entries(energy)) {
    if (scheduled.length === 0) {
      scenarios[nameKey] = {
        vehiclesRequired: 0,
        returnFeasible: e.feasible,
        socOnReturn: e.socOnReturn,
        unassignedColumns: [],
        vehicles: [],
      };
      continue;
    }
    const r = scheduleBlocks({
      columns: scheduled,
      energyPerReturnKwh: e.energyKwh,
      vehicle: fleet.vehicle,
      site: fleet.site,
      slotMinutes: fleet.slotMinutes,
    });
    scenarios[nameKey] = {
      vehiclesRequired: r.vehiclesRequired,
      returnFeasible: e.feasible,
      requiredSocWindow: round3(e.energyKwh / fleet.vehicle.batteryKwh),
      socOnReturn: r.energy.socOnReturn,
      unassignedColumns: r.unassignedColumns,
      peakCablesInUse: r.cables.peak,
      cablesWithinCapacity: r.cables.withinCapacity,
      cablesPerSlot: r.cables.perSlot,
      vehicles: r.vehicles.map((v) => ({
        ...v,
        blocks: v.blocks.map((b) => ({
          ...b,
          startHHMM: formatHHMM(b.start),
          endHHMM: formatHHMM(b.end),
        })),
      })),
      grid: r.grid,
    };
  }

  doc.fleet = {
    distance: {
      oneWayKm: { outbound: round1(oneWay.outbound), return: round1(oneWay.return) },
      returnTripKm: round1(returnTripKm),
      deadKm: round1(deadKm),
      source,
    },
    energy,
    breakEvenKwhPerKm: breakEven,
    charging,
    scenarios,
    parameters: {
      vehicle: {
        model: fleet.vehicle.model,
        batteryKwh: fleet.vehicle.batteryKwh,
        socFloor: fleet.vehicle.socFloor,
      },
      site: { plugHandlingMinutes: fleet.site.plugHandlingMinutes },
    },
  };

  log.info(
    {
      returnTripKm: round1(returnTripKm),
      energyKwh: Object.fromEntries(Object.entries(energy).map(([k, v]) => [k, v.energyKwh])),
      feasible: Object.fromEntries(Object.entries(energy).map(([k, v]) => [k, v.feasible])),
      vehicles: Object.fromEntries(Object.entries(scenarios).map(([k, v]) => [k, v.vehiclesRequired])),
    },
    "fleet computed",
  );
  return ctx;
}
