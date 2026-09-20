/**
 * Block scheduler (DESIGN_DOC §5.5). Pure function.
 *
 * Assigns timetable columns (one driver return trip each) to vehicles, greedily in departure
 * order, so that each vehicle: has returned to depot, has recharged to full SoC under the
 * cable allocation available in the intervening slots, and the site never exceeds its cable
 * count. Produces the fleet size, per-vehicle block pattern, per-slot cable usage, and a
 * Gantt-ready table.
 *
 * Simplifications (stated in the Methodology view):
 *  - Every vehicle starts the day at full SoC.
 *  - A vehicle charges immediately on return, using as many cables as are free (up to the
 *    per-vehicle max), re-evaluated every slot; charging stops at full.
 *  - One return trip per charge (energy model decides SoC on return). Returns below the reserve
 *    floor are still scheduled when the trip fits the full pack; only trips needing more than
 *    100% of the pack are left unassigned.
 */

import { effectivePowerKw } from "./charging.js";
import { FULL_SOC } from "./energy.js";

/** Service-day grid for the fleet Gantt: 07:00 → 07:00 (+1). */
export const FLEET_DAY_START_MIN = 7 * 60;
export const FLEET_DAY_END_MIN = 31 * 60;

/**
 * @param {object} p
 * @param {Array<{ columnId: string, depotDeparture: number, depotArrival: number }>} p.columns  minutes, service-day
 * @param {number} p.energyPerReturnKwh
 * @param {{ batteryKwh: number, socFloor: number, maxChargePowerKw: number }} p.vehicle
 * @param {{ cables: number, cablePowerKw: number, maxCablesPerVehicle: number, plugHandlingMinutes: number }} p.site
 * @param {number} [p.slotMinutes=15]
 */
export function scheduleBlocks(p) {
  const slot = p.slotMinutes ?? 15;
  const cols = [...p.columns].sort((a, b) => a.depotDeparture - b.depotDeparture);
  const dayStart = p.dayStartMin ?? FLEET_DAY_START_MIN;
  const dayEnd = p.dayEndMin ?? FLEET_DAY_END_MIN;
  const nSlots = (dayEnd - dayStart) / slot;
  const slotIndex = (t) => Math.floor((t - dayStart) / slot);

  const energyPerReturnSoc = p.energyPerReturnKwh / p.vehicle.batteryKwh;
  const socOnReturn = FULL_SOC - energyPerReturnSoc;
  const returnFeasible = socOnReturn >= p.vehicle.socFloor;

  /** @type {Array<{ id: string, soc: number, availableFrom: number, blocks: Array<object>, columnIds: string[] }>} */
  const vehicles = [];
  const cablesUsed = new Array(nSlots).fill(0);
  const unassigned = [];

  const charging = new Set();
  const byDeparture = new Map();
  for (const c of cols) {
    const s = slotIndex(c.depotDeparture);
    if (!byDeparture.has(s)) byDeparture.set(s, []);
    byDeparture.get(s).push(c);
  }
  const onTrip = new Map();

  for (let s = 0; s < nSlots; s++) {
    const t = dayStart + s * slot;

    for (const [vid, c] of [...onTrip]) {
      if (slotIndex(c.depotArrival) === s) {
        const v = vehicles.find((x) => x.id === vid);
        v.soc = Math.max(0, v.soc - energyPerReturnSoc);
        v.availableFrom = c.depotArrival;
        onTrip.delete(vid);
        if (v.soc < FULL_SOC - 1e-9) charging.add(vid);
      }
    }

    for (const c of byDeparture.get(s) ?? []) {
      if (p.energyPerReturnKwh > p.vehicle.batteryKwh) {
        unassigned.push({ columnId: c.columnId, reason: "one return exceeds full pack capacity" });
        continue;
      }
      let v = vehicles
        .filter((x) => !onTrip.has(x.id) && x.availableFrom <= c.depotDeparture && x.soc >= FULL_SOC - 1e-9)
        .sort((a, b) => a.availableFrom - b.availableFrom)[0];
      if (!v) {
        v = { id: `V${vehicles.length + 1}`, soc: FULL_SOC, availableFrom: dayStart, blocks: [], columnIds: [] };
        vehicles.push(v);
      }
      charging.delete(v.id);
      onTrip.set(v.id, c);
      v.columnIds.push(c.columnId);
      v.blocks.push({ type: "trip", columnId: c.columnId, start: c.depotDeparture, end: c.depotArrival, socStart: round3(v.soc) });
    }

    let free = p.site.cables;
    const chargers = [...charging].map((id) => vehicles.find((x) => x.id === id)).sort((a, b) => a.availableFrom - b.availableFrom);
    for (const v of chargers) {
      if (free <= 0) break;
      const cables = Math.min(p.site.maxCablesPerVehicle, free);
      const powerKw = effectivePowerKw(cables, p.site, p.vehicle);
      const last = v.blocks.at(-1);
      const continuing = last && last.type === "charge" && last.end === t;
      const sessionStart = continuing ? t : Math.max(t, v.availableFrom);
      const effectiveMin = Math.max(0, t + slot - sessionStart - (continuing ? 0 : p.site.plugHandlingMinutes));
      const addedSoc = (powerKw * (effectiveMin / 60)) / p.vehicle.batteryKwh;
      const newSoc = Math.min(FULL_SOC, v.soc + addedSoc);
      free -= cables;
      cablesUsed[s] += cables;
      if (continuing && last.cables === cables) {
        last.end = t + slot; last.socEnd = round3(newSoc);
      } else {
        v.blocks.push({ type: "charge", start: sessionStart, end: t + slot, cables, powerKw, socStart: round3(v.soc), socEnd: round3(newSoc) });
      }
      v.soc = newSoc;
      if (v.soc >= FULL_SOC - 1e-9) { charging.delete(v.id); v.availableFrom = t + slot; }
    }
  }

  for (const v of vehicles) {
    v.blocks.sort((a, b) => a.start - b.start);
    const filled = [];
    let cursor = dayStart;
    for (const b of v.blocks) {
      if (b.start > cursor) filled.push({ type: "idle", start: cursor, end: b.start });
      filled.push(b);
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < dayEnd) filled.push({ type: "idle", start: cursor, end: dayEnd });
    v.blocks = filled;
    v.socEndOfDay = round3(v.soc);
  }

  const peakCables = Math.max(0, ...cablesUsed);
  return {
    vehiclesRequired: vehicles.length,
    vehicles: vehicles.map(({ id, blocks, columnIds, socEndOfDay }) => ({ id, columnIds, blocks, socEndOfDay })),
    unassignedColumns: unassigned,
    energy: { energyPerReturnKwh: p.energyPerReturnKwh, socOnReturn: round3(socOnReturn), returnFeasible },
    cables: { perSlot: cablesUsed, peak: peakCables, capacity: p.site.cables, withinCapacity: peakCables <= p.site.cables },
    grid: { dayStart, dayEnd, slotMinutes: slot, slots: nSlots },
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;
