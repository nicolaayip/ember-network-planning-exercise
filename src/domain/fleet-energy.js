/**
 * Shared fleet distance / energy helpers for selection cap checks.
 * @format
 */

import { DIRECTIONS, isDepot } from "./document.js";
import { scheduleBlocks } from "./block-scheduler.js";
import { haversineMetres } from "../lib/geo.js";
import { parseHHMM } from "../lib/time.js";

const WINDING_FACTOR = 1.1;

function legDistanceKm(ctx) {
  const { document: doc } = ctx;
  let km = 0;
  for (const d of DIRECTIONS) {
    if (ctx.legs?.[d]?.length) km += ctx.legs[d].reduce((s, l) => s + l.distanceKm, 0);
    else {
      const pts = doc.directions[d].orderedStops.map((s) => s.coordinates);
      for (let i = 1; i < pts.length; i++)
        km += (haversineMetres(pts[i - 1], pts[i]) / 1000) * WINDING_FACTOR;
    }
  }
  if (!doc.directions.outbound.orderedStops.some(isDepot)) km += 6;
  km += ctx.config.fleet.depotToChargerKm * 2;
  return km;
}

/** Dead-leg allowances (minutes) from the proposal's first column, default 15 each. */
export function deadLegAllowances(doc) {
  const c = doc.timetableColumns[0];
  const out = c?.depotDeparture
    ? parseHHMM(c.outboundDeparture) - parseHHMM(c.depotDeparture)
    : 15;
  const inn =
    c?.depotArrival && c?.returnArrival
      ? parseHHMM(c.depotArrival) - parseHHMM(c.returnArrival)
      : 15;
  return { out, in: inn };
}

/** Central-scenario energy per return and block-scheduler helper for fleet-cap checks. */
export function fleetScheduleContext(ctx, dead = deadLegAllowances(ctx.document)) {
  const fleet = ctx.config.fleet;
  const energyKwh = legDistanceKm(ctx) * fleet.consumptionKwhPerKm.central;
  const vehicle = fleet.vehicle;
  const vehiclesFor = (columns) => {
    if (!columns.length) return 0;
    const r = scheduleBlocks({
      columns,
      energyPerReturnKwh: energyKwh,
      vehicle,
      site: fleet.site,
      slotMinutes: fleet.slotMinutes,
    });
    return r.unassignedColumns.length ? Infinity : r.vehiclesRequired;
  };
  return { energyKwh: Math.round(energyKwh), vehiclesFor, deadOut: dead.out, deadIn: dead.in };
}
