/** @format */

import type {
  Assumption,
  CompetitorDeparture,
  HeadwayGap,
  Direction,
  DirectionName,
  EngineDocument,
  TimetableDisplayRow,
  Leg,
  ODPair,
  ScenarioName,
  ServiceTemporalWindows,
  Stop,
  TimetableColumn,
  TemporalWindows,
} from "../types";
import {
  bandLabel,
  bandPeriodLabel,
  baselineSampleId as engineBaselineSampleId,
} from "@engine/domain/traffic-bands.js";
import { trafficSamplePeriodLabel } from "@engine/domain/temporal-windows.js";
import { clock, isNum, parseHHMM } from "./format";

export const SCENARIOS: ScenarioName[] = ["low", "central", "high"];
export const DIRECTIONS: DirectionName[] = ["outbound", "return"];

/** Weekend leisure search window (matches engine `detectWeekendBusyHour` searchFrom/searchTo). */
export const WEEKEND_LEISURE_SEARCH = "08:00–18:00";

export { trafficSamplePeriodLabel, bandLabel, bandPeriodLabel };

/** Weekday band sample ids (peaks and valleys). */
export function weekdayTrafficSampleIds(
  tw: TemporalWindows | undefined,
  direction: DirectionName,
): string[] {
  return (serviceTemporalWindows(tw, direction)?.weekdayBands ?? []).map((b) => b.id);
}

/** Weekend sample id — one peak per direction, same naming as Peak 1 on the traffic windows tab. */
export function weekendTrafficSampleIds(): string[] {
  return ["weekend"];
}

/** Traffic sample ids for legs routing: detected weekday bands + weekend. */
export function trafficSamples(
  tw: TemporalWindows | undefined,
  direction: DirectionName,
): string[] {
  return [...weekdayTrafficSampleIds(tw, direction), ...weekendTrafficSampleIds()];
}

export function sampleLabel(
  sampleId: string,
  tw: TemporalWindows | undefined,
  direction: DirectionName,
): string {
  if (sampleId === "weekend") return "Peak 1";
  const band = serviceTemporalWindows(tw, direction)?.weekdayBands?.find(
    (b) => b.id === sampleId,
  );
  return band ? bandLabel(band) : sampleId;
}

/** Deepest valley band id — baseline coach-adjusted reference. */
export function baselineSampleId(
  tw: TemporalWindows | undefined,
  direction: DirectionName,
): string {
  return engineBaselineSampleId(serviceTemporalWindows(tw, direction)?.weekdayBands);
}

/** Weekday band clock times for a service direction; supports legacy flat documents. */
export function serviceTemporalWindows(
  tw: TemporalWindows | undefined,
  direction: DirectionName,
): ServiceTemporalWindows | undefined {
  if (!tw) return undefined;
  return tw[direction] ?? tw.outbound ?? tw.return;
}

/** One row from the §6.7 assumptions register (stamped from config on engine run). */
export function assumptionRow(
  doc: EngineDocument | undefined,
  key: string,
): Assumption | undefined {
  return doc?.assumptions?.find((a) => a.key === key);
}

export function assumptionNumber(
  doc: EngineDocument | undefined,
  key: string,
): number | null {
  const v = assumptionRow(doc, key)?.value;
  return isNum(v) ? Number(v) : null;
}

export function pathDetourWarnFromDocument(
  doc: EngineDocument | undefined,
): number | null {
  return assumptionNumber(doc, "pathDetourWarnRatio");
}

export function headwayGapThresholdFromDocument(
  doc: EngineDocument | undefined,
): number | null {
  return assumptionNumber(doc, "headwayGapThresholdMinutes");
}

/** Coach time factor from the stamped assumptions register, or inferred from leg output. */
export function coachFactorFromDocument(
  doc: EngineDocument | undefined,
  legs: Leg[] | undefined,
  scenario: ScenarioName = "central",
): number | null {
  const row = doc?.assumptions?.find((a) => a.key === "coachTimeFactor");
  const fromRegister =
    scenario === "low" ? row?.low : scenario === "high" ? row?.high : row?.value;
  if (isNum(fromRegister)) return Number(fromRegister);

  const leg = legs?.find(
    (l) =>
      isNum(l.coachAdjustedMin?.[scenario]) &&
      l.windows &&
      Object.keys(l.windows).length > 0,
  );
  if (!leg) return null;
  const baselineKey =
    Object.keys(leg.windows ?? {}).find((k) => k.startsWith("valley")) ??
    Object.keys(leg.windows ?? {})[0];
  const baseCar = leg.windows?.[baselineKey]?.durationMin;
  const coach = leg.coachAdjustedMin?.[scenario];
  return isNum(baseCar) && isNum(coach) && baseCar > 0 ? coach / baseCar : null;
}

function legCoachFactor(
  leg: Leg | undefined,
  doc?: EngineDocument,
  scenario: ScenarioName = "central",
): number | null {
  if (isNum(leg?.coachSpeedFactor)) {
    const row = doc?.assumptions?.find((a) => a.key === "coachTimeFactor");
    const central = row?.value;
    const target =
      scenario === "low" ? row?.low : scenario === "high" ? row?.high : central;
    if (isNum(central) && isNum(target) && central > 0) {
      return (
        Math.round(leg.coachSpeedFactor * (Number(target) / Number(central)) * 1000) /
        1000
      );
    }
    return leg.coachSpeedFactor;
  }
  return coachFactorFromDocument(doc, leg ? [leg] : undefined, scenario);
}

/** Coach leg minutes: static x factor + max(0, duration − static). */
export function coachLegMin(
  leg: Leg | undefined,
  sampleId: string,
  doc?: EngineDocument,
  scenario: ScenarioName = "central",
): number | null {
  const w = leg?.windows?.[sampleId];
  const duration = w?.durationMin;
  const staticMin = w?.staticDurationMin;
  const factor = legCoachFactor(leg, doc, scenario);
  if (!isNum(duration) || !isNum(staticMin) || !isNum(factor)) return null;
  const congestion = Math.max(0, duration - staticMin);
  return Math.round((staticMin * factor + congestion) * 10) / 10;
}

/** Typical passenger dwell (seconds) baked into the scenario by the engine. */
export function documentDwellSeconds(dir: Direction | undefined): number {
  const dwells = passengerStops(dir)
    .map((s) => s.dwellTimeBufferSeconds)
    .filter(isNum);
  if (!dwells.length) return 0;
  return dwells[0];
}

/** Coach x factor + dwell at the from stop — comparable to proposedMin (dep→dep incl. dwell). */
export function legModelledTotalMin(
  leg: Leg | undefined,
  sampleId: string,
  dwellSec: number,
  doc?: EngineDocument,
  scenario: ScenarioName = "central",
): number | null {
  const coach = coachLegMin(leg, sampleId, doc, scenario);
  if (!isNum(coach)) return null;
  return Math.round((coach + dwellSec / 60) * 10) / 10;
}

/** Proposed leg minutes minus modelled total (coach + dwell at the from stop). */
export function legDeltaMin(
  proposedMin: unknown,
  leg: Leg | undefined,
  sampleId: string,
  dwellSec: number,
  doc?: EngineDocument,
  scenario: ScenarioName = "central",
): number | null {
  const modelled = legModelledTotalMin(leg, sampleId, dwellSec, doc, scenario);
  if (!isNum(proposedMin) || !isNum(modelled)) return null;
  return Math.round((proposedMin - modelled) * 10) / 10;
}

/** Modelled total from stamped leg output (baseline coach scenario + document dwell rules). */
export function legStampedModelledTotalMin(
  leg: Leg,
  dir: Direction | undefined,
  directionName: DirectionName,
  scenario: ScenarioName = "central",
): number | null {
  const coach = leg.coachAdjustedMin?.[scenario];
  if (!isNum(coach)) return null;
  const layover = layoverStopId(dir, directionName);
  const fromStop = dir?.orderedStops?.find((s) => s.naptanId === leg.fromStopId);
  const dwellSec = legDepartureDwellSeconds(leg, fromStop, directionName, layover);
  return Math.round((coach + dwellSec / 60) * 10) / 10;
}

export const isDepotStop = (s: Stop | undefined): boolean => s?.role === "depot";

/** Legs table row label: D for depot run, 1…n for passenger legs. */
export function legRowLabel(legs: Leg[], index: number): string {
  if (legs[index].deadLeg) return "D";
  return String(legs.slice(0, index).filter((l) => !l.deadLeg).length + 1);
}

/** OSM carriageway kind on the leg's to-stop (tagged by the engine). */
export function legCarriagewayKind(
  dir: Direction | undefined,
  leg: Leg,
): Stop["carriagewayKind"] | undefined {
  return dir?.orderedStops?.find((s) => s.naptanId === leg.toStopId)?.carriagewayKind;
}

const CARRIAGEWAY_LABELS: Record<NonNullable<Stop["carriagewayKind"]>, string> = {
  urban: "Urban",
  single: "Single",
  dual: "Dual",
};

/** Display label for a carriageway kind. */
export function carriagewayKindLabel(
  kind: Stop["carriagewayKind"] | undefined,
): string | null {
  return kind ? (CARRIAGEWAY_LABELS[kind] ?? kind) : null;
}
/** Always-served terminals (first/last passenger stop) — informational; does not affect dwell. */
export const isTerminalStop = (s: Stop | undefined): boolean => s?.alwaysServed === true;

/** Far-end terminal where the driver layover sits — first passenger stop on return. */
export function layoverStopId(
  dir: Direction | undefined,
  directionName: DirectionName,
): string | null {
  const pax = passengerStops(dir);
  return directionName === "return" && pax.length ? pax[0].naptanId : null;
}

/** Passenger dwell at departure: all calling points except depot and the return layover stop. */
export function schedulingDwellSeconds(
  s: Stop | undefined,
  directionName: DirectionName,
  layoverId: string | null,
  uniformDwellSec?: number,
): number {
  if (!s || isDepotStop(s)) return 0;
  if (directionName === "return" && layoverId && s.naptanId === layoverId) return 0;
  if (uniformDwellSec != null && Number.isFinite(uniformDwellSec))
    return Math.max(0, uniformDwellSec);
  return s.dwellTimeBufferSeconds ?? 0;
}

/** Dwell before a leg leaves its from-stop; dead legs carry no passenger dwell. */
export function legDepartureDwellSeconds(
  leg: Leg,
  fromStop: Stop | undefined,
  directionName: DirectionName,
  layoverId: string | null,
  uniformDwellSec?: number,
): number {
  if (leg.deadLeg) return 0;
  return schedulingDwellSeconds(fromStop, directionName, layoverId, uniformDwellSec);
}

function totalPassengerLegDwellMin(
  dir: Direction | undefined,
  directionName: DirectionName,
  uniformDwellSec?: number,
): number {
  const layover = layoverStopId(dir, directionName);
  const byId = stopIndex(dir);
  let sec = 0;
  for (const l of passengerLegs(dir)) {
    sec += legDepartureDwellSeconds(
      l,
      byId.get(l.fromStopId),
      directionName,
      layover,
      uniformDwellSec,
    );
  }
  return sec / 60;
}
/** Passenger stops in route order (the depot point excluded). */
export const passengerStops = (dir: Direction | undefined): Stop[] =>
  (dir?.orderedStops ?? []).filter((s) => !isDepotStop(s));

function coachMinForSample(
  leg: Leg,
  sampleId: string,
  doc?: EngineDocument,
): number | null {
  return coachLegMin(leg, sampleId, doc);
}

/** End-to-end modelled minutes for one traffic sample (first → last passenger stop). Prefers engine `endToEndMin`. */
export function modelledEndToEndSample(
  dir: Direction | undefined,
  sampleId: string,
  directionName: DirectionName,
  uniformDwellSec?: number,
  doc?: EngineDocument,
): number | null {
  const fromEngine = dir?.endToEndMin?.[sampleId];
  if (isNum(fromEngine)) {
    if (uniformDwellSec == null) return fromEngine;
    const dwellDelta =
      totalPassengerLegDwellMin(dir, directionName, uniformDwellSec) -
      totalPassengerLegDwellMin(dir, directionName);
    return Math.round((fromEngine + dwellDelta) * 10) / 10;
  }

  const legs = passengerLegs(dir);
  if (!legs.length) return null;
  let total = 0;
  for (const l of legs) {
    const coach = coachMinForSample(l, sampleId, doc);
    if (!isNum(coach)) return null;
    total += coach;
  }
  return (
    Math.round(
      (total + totalPassengerLegDwellMin(dir, directionName, uniformDwellSec)) * 10,
    ) / 10
  );
}

/** Modelled service run including depot dead leg(s): passenger end-to-end + dead-leg coach central. */
export function modelledEndToEndServiceSample(
  dir: Direction | undefined,
  sampleId: string,
  directionName: DirectionName,
  uniformDwellSec?: number,
  doc?: EngineDocument,
): number | null {
  const pax = modelledEndToEndSample(dir, sampleId, directionName, uniformDwellSec, doc);
  if (!isNum(pax)) return null;
  let dead = 0;
  for (const l of deadLegs(dir)) {
    const coach = coachMinForSample(l, sampleId, doc);
    if (!isNum(coach)) return null;
    dead += coach;
  }
  return Math.round((pax + dead) * 10) / 10;
}

function legStaticMin(leg: Leg): number | null {
  if (!leg.windows) return null;
  for (const w of Object.values(leg.windows)) {
    if (w && isNum(w.staticDurationMin)) return w.staticDurationMin;
  }
  return null;
}

export function stopSequenceIndex(
  dir: Direction | undefined,
  stopId: string,
): number | undefined {
  const idx = dir?.orderedStops?.findIndex((s) => s.naptanId === stopId) ?? -1;
  return idx >= 0 ? idx : undefined;
}

/** Free-flow coach in-vehicle minutes along the service route (static x per-leg factor + dwell). */
export function pairFreeFlowCoachMinutes(
  dir: Direction | undefined,
  pair: ODPair,
  doc?: EngineDocument,
): number | null {
  const legs = dir?.legs ?? [];
  if (!legs.length) return null;
  const i = stopSequenceIndex(dir, pair.originStopId);
  const j = stopSequenceIndex(dir, pair.destinationStopId);
  if (i === undefined || j === undefined || i >= j) return null;

  const fallback = coachFactorFromDocument(doc, legs);
  let total = 0;
  for (let k = i; k < j; k++) {
    const staticMin = legStaticMin(legs[k]);
    const factor = legCoachFactor(legs[k], doc) ?? fallback;
    if (!isNum(staticMin) || !isNum(factor)) return null;
    total += staticMin * factor;
  }
  if (isNum(pair.dwellMinutesBetween)) total += pair.dwellMinutesBetween;
  return Math.round(total * 10) / 10;
}

/** Free-flow coach min ÷ direct car static min for one OD pair. */
export function pairFreeFlowTimeRatio(
  dir: Direction | undefined,
  pair: ODPair,
  doc?: EngineDocument,
): number | null {
  const coach = pairFreeFlowCoachMinutes(dir, pair, doc);
  const car = pair.directCarStaticDriveMinutes;
  if (!isNum(coach) || !isNum(car) || car <= 0) return null;
  return Math.round((coach / car) * 1000) / 1000;
}

/** End-to-end coach run: Σ static x per-leg factor + dwell. */
export function freeFlowEndToEndService(
  dir: Direction | undefined,
  directionName: DirectionName,
  uniformDwellSec?: number,
  doc?: EngineDocument,
): number | null {
  const legs = dir?.legs ?? [];
  if (!legs.length) return null;
  const fallback = coachFactorFromDocument(doc, legs);
  let total = 0;
  for (const l of legs) {
    const staticMin = legStaticMin(l);
    const factor = legCoachFactor(l, doc) ?? fallback;
    if (!isNum(staticMin) || !isNum(factor)) return null;
    total += staticMin * factor;
  }
  return (
    Math.round(
      (total + totalPassengerLegDwellMin(dir, directionName, uniformDwellSec)) * 10,
    ) / 10
  );
}

export const depotStop = (dir: Direction | undefined): Stop | undefined =>
  dir?.orderedStops.find(isDepotStop);
/** Legs that carry passengers (dead legs to/from the depot excluded). */
export const passengerLegs = (dir: Direction | undefined): Leg[] =>
  (dir?.legs ?? []).filter((l) => !l.deadLeg);
export const deadLegs = (dir: Direction | undefined): Leg[] =>
  (dir?.legs ?? []).filter((l) => !!l.deadLeg);

export function stopIndex(dir: Direction | undefined): Map<string, Stop> {
  const m = new Map<string, Stop>();
  for (const s of dir?.orderedStops ?? []) m.set(s.naptanId, s);
  return m;
}

export function stopName(dir: Direction | undefined, id: string): string {
  return stopIndex(dir).get(id)?.stopName ?? id;
}

/** Proposed end-to-end minutes (first → last passenger stop) from the first column's stop times. */
export function proposedEndToEnd(dir: Direction | undefined, col = 0): number | null {
  const stops = passengerStops(dir);
  const a = parseHHMM(stops[0]?.proposedTimes?.[col]);
  const b = parseHHMM(stops.at(-1)?.proposedTimes?.[col]);
  return a != null && b != null ? b - a : null;
}

/** Proposed service run: depot → far terminal (outbound) or layover stop → depot (return). */
export function proposedEndToEndService(
  dir: Direction | undefined,
  directionName: DirectionName,
  col = 0,
): number | null {
  const depot = depotStop(dir);
  const pax = passengerStops(dir);
  if (!depot || !pax.length) return null;
  if (directionName === "outbound") {
    const a = parseHHMM(depot.proposedTimes?.[col]);
    const b = parseHHMM(pax.at(-1)?.proposedTimes?.[col]);
    return a != null && b != null ? b - a : null;
  }
  const a = parseHHMM(pax[0]?.proposedTimes?.[col]);
  const b = parseHHMM(depot.proposedTimes?.[col]);
  return a != null && b != null ? b - a : null;
}

/** Modelled end-to-end (coach central + dwell, passenger legs only) when the engine did not emit endToEndMin. */
export function modelledEndToEnd(
  dir: Direction | undefined,
  directionName: DirectionName,
  scenario: ScenarioName = "central",
): number | null {
  const legs = passengerLegs(dir);
  if (!legs.length) return null;
  let total = 0;
  for (const l of legs) {
    const v = l.coachAdjustedMin?.[scenario];
    if (!isNum(v)) return null;
    total += v;
  }
  return total + totalPassengerLegDwellMin(dir, directionName);
}

export function totalCatchment(dir: Direction | undefined): number | null {
  const stops = dir?.orderedStops ?? [];
  const vals = stops.map((s) => s.catchment?.population).filter(isNum);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

/** POI gravity summed across passenger stops (overlapping isochrones may double-count). */
export function totalPoi(dir: Direction | undefined): {
  weekday: number | null;
  weekend: number | null;
} {
  const vals = passengerStops(dir).map((s) => s.poi);
  const wd = vals.map((p) => p?.weekday).filter(isNum);
  const we = vals.map((p) => p?.weekend).filter(isNum);
  return {
    weekday: wd.length ? Math.round(wd.reduce((a, b) => a + b, 0) * 10) / 10 : null,
    weekend: we.length ? Math.round(we.reduce((a, b) => a + b, 0) * 10) / 10 : null,
  };
}

/** Assimilated EU drivers' hours checks only (excludes depot allowance and SoC). */
export const DRIVER_CHECK_KEYS = [
  "layoverAtLeast45Min",
  "continuousDrivingWithin4h30",
  "continuousWorkingWithin6h",
  "dailyDrivingWithin9h",
] as const;

export type DriverCheckKey = (typeof DRIVER_CHECK_KEYS)[number];

export function driverLegal(col: TimetableColumn): boolean {
  return DRIVER_CHECK_KEYS.every((k) => driverCheckOk(col, k) !== false);
}

/** Road Transport (Working Time) Regulations 2005 reg 7 — no work > 6 h without a break. */
export const MAX_CONTINUOUS_WORKING_MINUTES = 360;

/** Longest uninterrupted working stint before the layover break (driving-only in this model). */
export function continuousWorkingMinutes(col: TimetableColumn): number | undefined {
  if (col.driving?.continuousWorkingMinutes != null) {
    return col.driving.continuousWorkingMinutes;
  }
  const out = col.driving?.outboundDrivingMinutes;
  const ret = col.driving?.returnDrivingMinutes;
  if (out == null && ret == null) return undefined;
  return Math.max(out ?? 0, ret ?? 0);
}

export function driverCheckOk(
  col: TimetableColumn,
  key: DriverCheckKey,
): boolean | undefined {
  const stored = col.checks?.[key];
  if (stored !== undefined) return stored;
  if (key === "continuousWorkingWithin6h") {
    const m = continuousWorkingMinutes(col);
    return m == null ? undefined : m <= MAX_CONTINUOUS_WORKING_MINUTES;
  }
  return undefined;
}

/** Depot dep → depot arr, incl. layover (duty span). */
export function dailyWorkingMinutes(col: TimetableColumn): number | undefined {
  return col.driving?.dutyMinutes;
}

export function marketOpenings(doc: EngineDocument): number {
  let n = 0;
  for (const d of DIRECTIONS)
    for (const p of doc.directions[d]?.directionalODPairs ?? [])
      for (const g of p.supplyVector?.calculatedHeadwayGaps ?? [])
        if (g.isMarketOpening) n++;
  return n;
}

export type TimetableDay = "weekday" | "weekend";

/** Depot ↔ first/last passenger stop allowance from the proposed timetable (§5.1). */
export function deadLegAllowances(doc: EngineDocument): { out: number; in: number } {
  const c = doc.timetableColumns[0];
  const out =
    c?.depotDeparture && c?.outboundDeparture
      ? (parseHHMM(c.outboundDeparture) ?? 0) - (parseHHMM(c.depotDeparture) ?? 0)
      : 15;
  const inn =
    c?.depotArrival && c?.returnArrival
      ? (parseHHMM(c.depotArrival) ?? 0) - (parseHHMM(c.returnArrival) ?? 0)
      : 15;
  return { out, in: inn };
}

export function proposedTimetableRows(
  doc: EngineDocument,
  day: TimetableDay,
): TimetableDisplayRow[] {
  const evalCols = doc.timetableSelection?.[day]?.proposal?.columns ?? [];
  const byId = new Map(evalCols.map((c) => [c.columnId ?? "", c]));
  let cumulativeGapHits = 0;
  return (doc.timetableColumns ?? []).map((col, i) => {
    const ev = byId.get(col.columnId) ?? evalCols[i];
    const hits = ev?.pairsInOpenings;
    if (isNum(hits)) cumulativeGapHits += hits;
    return {
      columnId: col.columnId,
      outboundDeparture: col.outboundDeparture,
      outboundArrival: col.outboundArrival,
      returnDeparture: col.returnDeparture,
      returnArrival: col.returnArrival,
      depotDeparture: col.depotDeparture,
      depotArrival: col.depotArrival,
      layoverMinutes: col.layoverMinutes,
      pairsInOpenings: hits,
      outboundPairsInOpenings: ev?.outboundPairsInOpenings,
      returnPairsInOpenings: ev?.returnPairsInOpenings,
      cumulativeGapHits: isNum(hits) ? cumulativeGapHits : undefined,
    };
  });
}

function slotRankingRows(
  doc: EngineDocument,
  day: TimetableDay,
  which: "candidates" | "selected",
): TimetableDisplayRow[] {
  const dead = deadLegAllowances(doc);
  const slot = doc.timetableSelection?.[day]?.slotRanking;
  const cols =
    which === "selected" ? (slot?.selected?.columns ?? []) : (slot?.candidates ?? []);
  return cols.map((c) => {
    const outDep = parseHHMM(c.outboundDeparture);
    const retArr = parseHHMM(c.returnArrival);
    return {
      columnId: c.columnId ?? "–",
      rank: c.rank,
      outboundDeparture: c.outboundDeparture ?? "–",
      outboundArrival: c.outboundArrival,
      returnDeparture: c.returnDeparture ?? "–",
      returnArrival: c.returnArrival,
      depotDeparture: outDep != null ? clock(outDep - dead.out) : undefined,
      depotArrival: retArr != null ? clock(retArr + dead.in) : undefined,
      layoverMinutes: c.layoverMinutes,
      pairsInOpenings: c.pairsInOpenings,
      outboundPairsInOpenings: c.outboundPairsInOpenings,
      returnPairsInOpenings: c.returnPairsInOpenings,
      newGapHits: c.newGapHits,
      cumulativeGapHits: c.cumulativeGapHits,
    };
  });
}

export function slotCandidateRows(
  doc: EngineDocument,
  day: TimetableDay,
): TimetableDisplayRow[] {
  return slotRankingRows(doc, day, "candidates");
}

export function slotSelectedRows(
  doc: EngineDocument,
  day: TimetableDay,
): TimetableDisplayRow[] {
  return slotRankingRows(doc, day, "selected");
}

export function slotRankingMeta(doc: EngineDocument, day: TimetableDay) {
  const slot = doc.timetableSelection?.[day]?.slotRanking;
  const fleet = doc.timetableSelection?.fleetCap;
  const selected = slot?.selected;
  return {
    basis: slot?.basis,
    candidateCount: slot?.candidates?.length ?? 0,
    selectedCount: selected?.columns?.length ?? 0,
    vehiclesRequired: selected?.vehiclesRequired,
    stopReason: selected?.stopReason,
    curve: selected?.curve,
    proposalVehicles: fleet?.proposalVehicles,
    fleetCap: fleet?.cap,
  };
}

export function hasSupplyData(doc: EngineDocument): boolean {
  return DIRECTIONS.some((d) =>
    (doc.directions[d]?.directionalODPairs ?? []).some(
      (p) => (p.supplyVector?.calculatedHeadwayGaps?.length ?? 0) > 0,
    ),
  );
}

/** Sorted departure times for one competitor service. */
export function departureTimesForService(
  departures: CompetitorDeparture[] | undefined,
  service: string,
): string[] {
  return (departures ?? [])
    .filter((d) => d.service === service)
    .map((d) => d.time)
    .sort((a, b) => (parseHHMM(a) ?? 0) - (parseHHMM(b) ?? 0));
}

/** Competitor services departing at an exact timetable time on this pair. */
export function servicesAtDepartureTime(
  departures: CompetitorDeparture[] | undefined,
  time: string | undefined,
): string[] {
  if (!time) return [];
  return [...new Set((departures ?? []).filter((d) => d.time === time).map((d) => d.service))].sort();
}

export type HeadwayGapBounds = {
  before: string[];
  after: string[];
  beforeLabel: string | null;
  afterLabel: string | null;
};

/** Services bounding a headway gap; edge gaps use Day start / Day end labels. */
export function headwayGapBounds(
  gap: HeadwayGap,
  departures: CompetitorDeparture[] | undefined,
): HeadwayGapBounds {
  const before = servicesAtDepartureTime(departures, gap.gapStart);
  const after = servicesAtDepartureTime(departures, gap.gapEnd);
  return {
    before,
    after,
    beforeLabel: before.length === 0 ? "Day start" : null,
    afterLabel: after.length === 0 ? "Day end" : null,
  };
}

/** Primary competing line for a gap — next departure, or last of day on an evening edge. */
export function headwayGapDepartingLine(
  gap: HeadwayGap,
  departures: CompetitorDeparture[] | undefined,
): { services: string[]; edgeLabel: string | null } {
  const bounds = headwayGapBounds(gap, departures);
  if (bounds.after.length) return { services: bounds.after, edgeLabel: null };
  if (bounds.before.length) return { services: bounds.before, edgeLabel: null };
  return { services: [], edgeLabel: bounds.beforeLabel ?? bounds.afterLabel };
}

export function headwayGapServiceSummary(
  departures: CompetitorDeparture[] | undefined,
  services: string[],
): string {
  return services
    .map((service) => {
      const times = departureTimesForService(departures, service);
      return `${service}: ${times.join(", ") || "–"}`;
    })
    .join(" · ");
}

/** Per-service departure count for the competing-lines table. */
export function departuresPerService(
  lines: string[] | undefined,
  departures: CompetitorDeparture[] | undefined,
): Array<{ service: string; departuresPerDay: number }> {
  const counts = new Map<string, number>();
  for (const d of departures ?? [])
    counts.set(d.service, (counts.get(d.service) ?? 0) + 1);
  const ordered = lines?.length ? lines : [...counts.keys()].sort();
  return ordered.map((service) => ({
    service,
    departuresPerDay: counts.get(service) ?? 0,
  }));
}

export type PairCompetitionDay = "weekday" | "weekend";

export function pairCompetitionLines(pair: ODPair, day: PairCompetitionDay): string[] {
  const sv = pair.supplyVector;
  if (!sv) return [];
  return day === "weekend"
    ? (sv.saturdayDetectedOverlappingLines ?? [])
    : (sv.detectedOverlappingLines ?? []);
}

export function pairHasCompetition(
  pair: ODPair,
  day: PairCompetitionDay = "weekday",
): boolean {
  return pairCompetitionLines(pair, day).length > 0;
}

export const CHECK_LABEL: Record<string, string> = {
  layoverAtLeast45Min: "Layover ≥ 45 min",
  continuousDrivingWithin4h30: "Continuous driving ≤ 4 h 30",
  continuousWorkingWithin6h: "Continuous working ≤ 6 h",
  dailyDrivingWithin9h: "Daily driving ≤ 9 h",
  depotToFirstStopAllowanceSufficient: "Depot → first stop in time",
  lastStopToDepotAllowanceSufficient: "Last stop → depot in time",
  socOnReturnAboveFloor: "SoC on return ≥ floor",
};
