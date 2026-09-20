/**
 * Spreadsheet-shaped outputs (DESIGN_DOC §6). Each function returns rows (array of arrays);
 * `writeTables` serialises them as CSV into output/<routeId>/. Phase 4 tables live here now;
 * Stops / Legs / Timetable Comparison / Assumptions are added as their phases land.
 *
 * @format
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  baselineSampleId,
  bandPeriodLabel,
  routingSampleIds,
  weekdayBands,
} from "../domain/traffic-bands.js";
import { trafficSamplePeriodLabel } from "../domain/temporal-windows.js";
import { formatClock, formatDuration } from "../lib/time.js";

const pct = (x) => `${Math.round(x * 100)}%`;
const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) =>
  rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

/** §6.2 Legs table — per direction, one row per consecutive-stop leg. */
export function legsTable(doc, direction) {
  const dir = doc.directions[direction];
  if (!dir.legs) return [["no legs — topology did not run (Google Routes unavailable)"]];
  const name = (id) => dir.orderedStops.find((s) => s.naptanId === id)?.stopName ?? id;
  const samples = routingSampleIds(weekdayBands(doc.estimatedTemporalWindows, direction));
  const baseline = baselineSampleId(
    weekdayBands(doc.estimatedTemporalWindows, direction),
  );
  const carHeaders = samples.map((id) => `Car min ${id}`);
  const rows = [
    [
      "#",
      "From",
      "To",
      "Road km",
      "Crow-fly km",
      "Directness",
      "Warn >1.5",
      ...carHeaders,
      `Free-flow min (static, ${baseline})`,
      "Coach min low",
      "Coach min central",
      "Coach min high",
      "Dwell at origin (s)",
      "Proposed timetable min",
      "Delta vs coach central + dwell (min)",
    ],
  ];
  dir.legs.forEach((l, i) => {
    rows.push([
      i + 1,
      name(l.fromStopId),
      name(l.toStopId),
      l.distanceKm,
      l.crowFlyKm,
      l.directnessIndex,
      l.directnessWarning ? "YES" : "",
      ...samples.map((id) => l.windows[id]?.durationMin),
      l.windows[baseline]?.staticDurationMin,
      l.coachAdjustedMin.low,
      l.coachAdjustedMin.central,
      l.coachAdjustedMin.high,
      i > 0 ? dir.orderedStops[i].dwellTimeBufferSeconds : 0,
      l.proposedMin ?? "",
      l.deltaMin ?? "",
    ]);
  });
  const sum = (k) => Math.round(dir.legs.reduce((s, l) => s + (l[k] ?? 0), 0) * 10) / 10;
  const sumW = (w) =>
    Math.round(dir.legs.reduce((s, l) => s + (l.windows[w]?.durationMin ?? 0), 0) * 10) /
    10;
  const dwellMin =
    Math.round(
      dir.orderedStops.slice(1, -1).reduce((s, x) => s + x.dwellTimeBufferSeconds, 0) / 6,
    ) / 10;
  rows.push([]);
  rows.push([
    "TOTAL",
    "",
    "",
    sum("distanceKm"),
    "",
    "",
    "",
    ...samples.map(sumW),
    "",
    Math.round(dir.legs.reduce((s, l) => s + l.coachAdjustedMin.low, 0) * 10) / 10,
    Math.round(dir.legs.reduce((s, l) => s + l.coachAdjustedMin.central, 0) * 10) / 10,
    Math.round(dir.legs.reduce((s, l) => s + l.coachAdjustedMin.high, 0) * 10) / 10,
    "",
    sum("proposedMin"),
    "",
  ]);
  rows.push(["Dwell total (min, all intermediate stops)", dwellMin]);
  if (dir.endToEndMin)
    rows.push([
      "End-to-end coach central incl. dwell (min) by sample",
      ...Object.entries(dir.endToEndMin).map(([w, v]) => `${w}: ${v}`),
    ]);
  return rows;
}

/** §6.1 Stops table — per direction; demand/supply columns filled as later phases land. */
export function stopsTable(doc, direction) {
  const dir = doc.directions[direction];
  const rows = [
    [
      "#",
      "ATCO",
      "Stop",
      "Locality",
      "Lat",
      "Lng",
      "Always served",
      "Dwell (s)",
      "Proposed time (col 1)",
      "Deviation min (coach central + dwell)",
      "Deviation km",
      "Arriving leg directness",
      "Walk catchment pop (10 min)",
      "Catchment km²",
      "Zones",
      "Largest zone (share → allocated)",
      "POI weekday",
      "POI weekend",
    ],
  ];
  dir.orderedStops.forEach((s, i) => {
    const leg = dir.legs?.[i - 1];
    const c = s.catchment;
    const top = c?.zones?.[0];
    rows.push([
      s.sequenceOrder,
      s.naptanId,
      s.stopName,
      s.localityName ?? "",
      s.coordinates.lat,
      s.coordinates.lng,
      s.alwaysServed ? "yes" : "pre-booked",
      s.dwellTimeBufferSeconds,
      s.proposedTimes?.[0] ?? "",
      s.deviationMinutes ?? "",
      s.deviationKm ?? "",
      leg?.directnessIndex ?? "",
      c?.population ?? "",
      c?.areaKm2 ?? "",
      c?.zones?.length ?? "",
      top ? `${top.name} (${Math.round(top.ratio * 100)}% → ${top.allocated})` : "",
      s.poi?.weekday ?? "",
      s.poi?.weekend ?? "",
    ]);
  });
  return rows;
}

/** §1.4 Traffic profile — terminal-anchored basis sites and per-direction peaks. */
export function trafficProfileTable(doc) {
  const t = doc.trafficProfile;
  if (!t)
    return [
      [
        "no traffic profile — WebTRIS unavailable; fallback windows used",
        JSON.stringify(doc.estimatedTemporalWindows),
      ],
    ];
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  const tw = doc.estimatedTemporalWindows;
  const rows = [
    ["Source", t.source],
    ["Period", trafficSamplePeriodLabel(t.period)],
    [
      "Launch date assumed",
      t.period.launchDate ?? "n/a",
      "lead days",
      t.period.launchLeadDays ?? "n/a",
      "excluded dates (holidays/Christmas)",
      t.period.excludedDates ?? 0,
    ],
    [
      "Windows",
      ...(t.period.windows ?? []).map((w) => `${w.year}: ${w.start}..${w.end}`),
    ],
    [
      "Corridor with sites (km)",
      t.coverage?.corridorKmWithSites,
      "of",
      t.coverage?.corridorKmTotal,
    ],
    [],
    [
      "Legs routing — outbound",
      ...(tw?.outbound?.weekdayBands ?? []).flatMap((b) => [
        `${b.id} (${b.kind})`,
        `${bandPeriodLabel(b)} → ${b.apex}`,
      ]),
      "Weekend",
      tw?.outbound?.weekendDeparture,
    ],
    [
      "Legs routing — return",
      ...(tw?.return?.weekdayBands ?? []).flatMap((b) => [
        `${b.id} (${b.kind})`,
        `${bandPeriodLabel(b)} → ${b.apex}`,
      ]),
      "Weekend",
      tw?.return?.weekendDeparture,
    ],
    ["Weekend / weekday volume ratio", t.weekendToWeekdayVolumeRatio],
    [],
    [
      "Basis site",
      "Service",
      "Compass",
      "Anchor stop",
      "Site id",
      "Lat",
      "Lng",
      "Coverage",
      "Vehicles / weekday",
      "Profile",
      "Weekday bands",
      "Weekend peak",
      "Name",
    ],
    ...(t.basisSites ?? []).map((s) => [
      s.serviceDirection,
      s.compass,
      s.anchorStopName,
      s.id,
      s.lat ?? "",
      s.lng ?? "",
      s.weekdayCoverage,
      s.vehiclesPerWeekday,
      s.profileKind ?? "",
      (s.weekdayBands ?? []).map((b) => `${b.id} ${bandPeriodLabel(b)}`).join("; "),
      s.weekendBusyHour?.start && s.weekendBusyHour?.end
        ? `${bandPeriodLabel(s.weekendBusyHour)} → ${s.weekendBusyHour.apex ?? s.weekendBusyHour.busyHourStart}`
        : (s.weekendBusyHour?.apex ?? s.weekendBusyHour?.busyHourStart),
      s.name,
    ]),
    [],
    ["Hourly share of daily traffic (%)", ...hours],
  ];
  for (const s of t.basisSites ?? []) {
    rows.push([`${s.serviceDirection} weekday`, ...(s.weekdayHourlyPct ?? [])]);
    rows.push([`${s.serviceDirection} weekend`, ...(s.weekendHourlyPct ?? [])]);
  }
  return rows;
}

/** §6.3 Timetable comparison — proposal vs recommended, with the services-vs-captured-demand curve. */
export function timetableComparisonTable(doc) {
  const s = doc.timetableSelection;
  if (!s) return [["no timetable selection — step 9 did not run"]];
  const rows = [
    [
      "Scores are unit-free: share of demand-weighted pairs whose departure lands in a competitor market opening, weighted by how excessive the gap is ((gap − threshold) / gap). Threshold (min)",
      s.thresholdMinutes,
    ],
    [
      "Fleet cap",
      s.fleetCap?.cap ?? "none",
      s.fleetCap?.basis ?? "",
      "energy per return (kWh, central)",
      s.fleetCap?.energyPerReturnKwh ?? "",
    ],
    [
      "Candidate grid",
      `${s.candidateGrid?.from}–${s.candidateGrid?.to} every ${s.candidateGrid?.stepMin} min`,
      "layovers (min)",
      (s.candidateGrid?.layoversMin ?? []).join("/"),
    ],
    [],
  ];
  const p = s.weekday.proposal;
  if (p) {
    rows.push([
      "PROPOSED TIMETABLE (weekday, scored as timetabled)",
      "",
      "",
      "",
      "",
      "",
      "",
      `cumulative ${p.cumulative}`,
    ]);
    rows.push([
      "Column",
      "Outbound dep",
      "Return dep",
      "Standalone score",
      "Incremental score",
      "Cumulative",
      "Pairs in openings",
      "Outbound / return share",
      "Windows",
    ]);
    for (const c of p.columns)
      rows.push([
        c.columnId,
        c.outboundDeparture,
        c.returnDeparture,
        c.standaloneScore,
        c.incrementalScore,
        c.cumulative,
        c.pairsInOpenings,
        `${c.byDirection.outbound} / ${c.byDirection.return}`,
        `${c.bands?.outbound ?? c.windows?.outbound} / ${c.bands?.return ?? c.windows?.return}`,
      ]);
    rows.push([]);
  }
  for (const key of ["weekday", "weekend"]) {
    const r = s[key].recommended;
    if (!r) continue;
    const fit = r.fleetFit;
    rows.push([
      `RECOMMENDED (${key}, demand greedy)`,
      `${r.columns.length} discovered`,
      `${r.vehiclesRequired} vehicles if all run`,
      `cumulative ${r.cumulative}`,
      fit
        ? `fleet fit: ${fit.columns?.length} columns / ${fit.vehiclesRequired} vehicles → ${fit.cumulative}`
        : "no fleet cap",
      fit?.dropped?.length
        ? `dropped: ${fit.dropped.map((c) => c.columnId).join(", ")}`
        : "",
    ]);
    rows.push([
      "Column",
      "Outbound dep",
      "Outbound arr",
      "Layover (min)",
      "Return dep",
      "Return arr",
      "Marginal gain",
      "Cumulative",
      "Pairs in openings",
      "Windows",
    ]);
    for (const c of r.columns)
      rows.push([
        c.columnId,
        c.outboundDeparture,
        c.outboundArrival,
        c.layoverMinutes,
        c.returnDeparture,
        c.returnArrival,
        c.marginalGain,
        c.cumulative,
        c.pairsInOpenings,
        `${c.bands?.outbound ?? c.windows?.outbound} / ${c.bands?.return ?? c.windows?.return}`,
      ]);
    rows.push([
      "Curve (n → cumulative, marginal)",
      ...r.curve.map((x) => `${x.n}: ${x.cumulative} (+${x.marginal})`),
    ]);
    rows.push([]);
  }
  return rows;
}

/** §6.4 Energy table — one row per consumption scenario. */
export function energyTable(doc) {
  const f = doc.fleet;
  const rows = [
    [
      "Scenario",
      "kWh/km",
      "Return trip km",
      "Dead km",
      "Total km",
      "Energy per return (kWh)",
      "Usable window (kWh)",
      "Margin (kWh)",
      "SoC at depart",
      "SoC on return",
      "One return feasible",
      "Two returns feasible",
    ],
  ];
  for (const [name, e] of Object.entries(f.energy)) {
    rows.push([
      name,
      e.kwhPerKm,
      f.distance.returnTripKm,
      f.distance.deadKm,
      e.totalKm,
      e.energyKwh,
      e.usableKwh,
      e.marginKwh,
      pct(e.socStart),
      pct(e.socOnReturn),
      e.feasible ? "yes" : "NO",
      e.twoReturnsFeasible ? "yes" : "no",
    ]);
  }
  rows.push([]);
  rows.push([
    "Break-even consumption (kWh/km) at which one return exactly fills the usable window",
    f.breakEvenKwhPerKm,
  ]);
  rows.push(["Distance source", f.distance.source]);
  return rows;
}

/** §6.4 Charging table — recharge from central-scenario SoC-on-return to ceiling, per cable config. */
export function chargingTable(doc) {
  const f = doc.fleet;
  const rows = [
    [
      "Cables",
      "Power (kW)",
      "Energy to replace (kWh)",
      "Charging minutes",
      "Plug handling (min)",
      "Total (h:mm)",
    ],
  ];
  for (const [cables, c] of Object.entries(f.charging)) {
    const plug =
      c.plugHandlingMinutes ??
      (c.minutes != null && c.chargingMinutes != null
        ? c.minutes - c.chargingMinutes
        : "");
    rows.push([
      cables,
      c.powerKw,
      c.energyKwh,
      c.chargingMinutes,
      plug,
      formatDuration(c.minutes),
    ]);
  }
  return rows;
}

/** §6.6 Drivers' Shift Check — one row per timetable column. */
export function driversShiftTable(doc) {
  const rows = [
    [
      "Column",
      "Depot dep",
      "Outbound dep",
      "Outbound arr",
      "Layover (min)",
      "Layover slack vs 45 (min)",
      "Return dep",
      "Return arr",
      "Depot arr",
      "Outbound driving (min)",
      "Return driving (min)",
      "Daily driving (h:mm)",
      "Duty (h:mm)",
      "Break ≥ 45",
      "Stints ≤ 4h30",
      "Daily ≤ 9h",
      "SoC on return ≥ floor (central)",
      "Legal",
    ],
  ];
  for (const c of doc.timetableColumns) {
    if (!c.driving) {
      rows.push([
        c.columnId,
        c.depotDeparture,
        c.outboundDeparture,
        "",
        "",
        "",
        c.returnDeparture,
        "",
        c.depotArrival,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "no data",
      ]);
      continue;
    }
    const k = c.checks;
    const legal =
      k.layoverAtLeast45Min && k.continuousDrivingWithin4h30 && k.dailyDrivingWithin9h;
    rows.push([
      c.columnId,
      c.depotDeparture ?? "",
      c.outboundDeparture,
      c.outboundArrival,
      c.layoverMinutes,
      c.driving.layoverSlackMinutes,
      c.returnDeparture,
      c.returnArrival,
      c.depotArrival ?? "",
      c.driving.outboundDrivingMinutes,
      c.driving.returnDrivingMinutes,
      formatDuration(c.driving.dailyDrivingMinutes),
      formatDuration(c.driving.dutyMinutes),
      yn(k.layoverAtLeast45Min),
      yn(k.continuousDrivingWithin4h30),
      yn(k.dailyDrivingWithin9h),
      yn(k.socOnReturnAboveFloor),
      legal ? "yes" : "NO",
    ]);
  }
  return rows;
}

/** §6.5 Vehicle Gantt — rows = vehicles, 15-min columns, cell = T:C01 / CHx2 / idle; plus cable-count row. */
export function ganttTable(doc, scenario = "central") {
  const s = doc.fleet.scenarios[scenario];
  if (!s?.grid) return [["no schedule for scenario", scenario]];
  const { dayStart, slotMinutes, slots } = s.grid;
  const header = [
    "Vehicle / time",
    ...Array.from({ length: slots }, (_, i) => formatClock(dayStart + i * slotMinutes)),
  ];
  const rows = [
    [
      `Scenario: ${scenario} — ${s.vehiclesRequired} vehicles${s.note ? " — " + s.note : ""}`,
    ],
    header,
  ];
  for (const v of s.vehicles) {
    const cells = new Array(slots).fill("");
    for (const b of v.blocks) {
      const from = Math.max(0, Math.floor((b.start - dayStart) / slotMinutes));
      const to = Math.min(slots, Math.ceil((b.end - dayStart) / slotMinutes));
      const label =
        b.type === "trip"
          ? `T:${b.columnId}`
          : b.type === "charge"
            ? `CHx${b.cables}`
            : "idle";
      for (let i = from; i < to; i++) cells[i] = label;
    }
    rows.push([`${v.id} (${v.columnIds.join("+")})`, ...cells]);
  }
  rows.push([
    `Cables in use (≤ ${doc.fleet.scenarios[scenario].cablesPerSlot ? "4" : ""})`,
    ...(s.cablesPerSlot ?? []),
  ]);
  return rows;
}

/** Per-vehicle block list, long format — easier to chart than the wide Gantt. */
export function vehicleBlocksTable(doc, scenario = "central") {
  const s = doc.fleet.scenarios[scenario];
  const rows = [
    [
      "Scenario",
      "Vehicle",
      "Block",
      "Column",
      "Start",
      "End",
      "Duration (min)",
      "Cables",
      "Power (kW)",
      "SoC start",
      "SoC end",
    ],
  ];
  for (const v of s?.vehicles ?? []) {
    for (const b of v.blocks) {
      rows.push([
        scenario,
        v.id,
        b.type,
        b.columnId ?? "",
        formatClock(b.start),
        formatClock(b.end),
        b.end - b.start,
        b.cables ?? "",
        b.powerKw ?? "",
        b.socStart !== undefined ? pct(b.socStart) : "",
        b.socEnd !== undefined ? pct(b.socEnd) : "",
      ]);
    }
  }
  return rows;
}

/** Fleet summary across scenarios — the headline Q3 table. */
export function fleetSummaryTable(doc) {
  const rows = [
    [
      "Scenario",
      "kWh/km",
      "One return feasible",
      "Pack fraction per return",
      "Vehicles required",
      "Peak cables in use",
      "Within 4 cables",
      "Note",
    ],
  ];
  for (const [name, s] of Object.entries(doc.fleet.scenarios)) {
    rows.push([
      name,
      doc.fleet.energy[name].kwhPerKm,
      s.returnFeasible ? "yes" : "NO",
      pct(s.requiredSocWindow),
      s.vehiclesRequired,
      s.peakCablesInUse ?? "",
      s.cablesWithinCapacity === undefined ? "" : yn(s.cablesWithinCapacity),
      s.note ?? "",
    ]);
  }
  return rows;
}

const yn = (b) => (b ? "yes" : "NO");

/**
 * Write every available table as CSV into <outputDir>/<routeId>/.
 * @returns {Promise<string[]>} written paths
 */
export async function writeTables(doc, outputDir) {
  const dir = path.join(outputDir, doc.routeId);
  await mkdir(dir, { recursive: true });
  const files = {};
  files["traffic-profile.csv"] = trafficProfileTable(doc);
  files["timetable-comparison.csv"] = timetableComparisonTable(doc);
  for (const d of ["outbound", "return"]) {
    files[`stops-${d}.csv`] = stopsTable(doc, d);
    files[`legs-${d}.csv`] = legsTable(doc, d);
  }
  if (doc.fleet) {
    files["fleet-summary.csv"] = fleetSummaryTable(doc);
    files["energy.csv"] = energyTable(doc);
    files["charging.csv"] = chargingTable(doc);
    files["drivers-shift-check.csv"] = driversShiftTable(doc);
    for (const sc of Object.keys(doc.fleet.scenarios)) {
      files[`gantt-${sc}.csv`] = ganttTable(doc, sc);
      files[`vehicle-blocks-${sc}.csv`] = vehicleBlocksTable(doc, sc);
    }
  }
  const written = [];
  for (const [name, rows] of Object.entries(files)) {
    const p = path.join(dir, name);
    await writeFile(p, toCsv(rows));
    written.push(p);
  }
  return written;
}
