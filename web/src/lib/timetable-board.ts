/** @format */

import type { DirectionName, EngineDocument, TimetableDisplayRow } from "../types";
import {
  documentDwellSeconds,
  layoverStopId,
  legDepartureDwellSeconds,
  legModelledTotalMin,
  passengerLegs,
  passengerStops,
} from "./derive";
import { clock, displayServiceTime, isNum, parseHHMM } from "./format";

export interface TimetableBoardJourney {
  id: string;
  times: string[];
}

export interface TimetableBoardModel {
  heading: string;
  stops: string[];
  journeys: TimetableBoardJourney[];
}

export interface TimetableBoardGroup {
  id: string;
  label: string;
  journeys: TimetableBoardJourney[];
}

export interface TimetableBoardGroupedModel {
  heading: string;
  stops: string[];
  groups: TimetableBoardGroup[];
}

function sampleForDay(
  bands: { outbound?: string; return?: string } | undefined,
  direction: DirectionName,
  day: "weekday" | "weekend",
): string {
  if (day === "weekend") return "weekend";
  return direction === "outbound" ? (bands?.outbound ?? "peak1") : (bands?.return ?? "peak1");
}

function modelledStopTimes(
  doc: EngineDocument,
  direction: DirectionName,
  firstDepMin: number,
  sampleId: string,
): string[] | null {
  const dir = doc.directions[direction];
  const pax = passengerStops(dir);
  const legs = passengerLegs(dir);
  const layover = layoverStopId(dir, direction);
  const dwellUniform = documentDwellSeconds(dir);
  const mins: number[] = [firstDepMin];

  for (let i = 0; i < pax.length - 1; i++) {
    const leg = legs.find(
      (l) => l.fromStopId === pax[i].naptanId && l.toStopId === pax[i + 1].naptanId,
    );
    if (!leg) return null;
    const dwell = legDepartureDwellSeconds(
      leg,
      pax[i],
      direction,
      layover,
      dwellUniform,
    );
    const legMin = legModelledTotalMin(leg, sampleId, dwell, doc, "central");
    if (!isNum(legMin)) return null;
    mins.push(mins[i] + legMin);
  }

  return mins.map((m) => displayServiceTime(clock(m)));
}

function stopLabels(doc: EngineDocument, direction: DirectionName): string[] {
  return passengerStops(doc.directions[direction]).map((s) => {
    const loc = s.localityName ? `, ${s.localityName}` : "";
    return `${s.stopName}${loc}`;
  });
}

function proposedDirectionBoard(
  doc: EngineDocument,
  direction: DirectionName,
  serviceCount: number,
): TimetableBoardModel | null {
  const dir = doc.directions[direction];
  const pax = passengerStops(dir);
  const cols = doc.timetableColumns.slice(0, serviceCount);
  if (!cols.length || !pax.length) return null;

  const journeys: TimetableBoardJourney[] = cols.map((col, colIdx) => ({
    id: col.columnId,
    times: pax.map((s) => displayServiceTime(s.proposedTimes?.[colIdx] ?? undefined)),
  }));

  return {
    heading: dir.label ?? direction,
    stops: stopLabels(doc, direction),
    journeys,
  };
}

function suggestedDirectionBoard(
  doc: EngineDocument,
  direction: DirectionName,
  day: "weekday" | "weekend",
  rows: TimetableDisplayRow[],
): TimetableBoardModel | null {
  const dir = doc.directions[direction];
  if (!rows.length) return null;

  const journeys: TimetableBoardJourney[] = [];
  const slotCols = doc.timetableSelection?.[day]?.slotRanking?.selected?.columns ?? [];
  for (const row of rows) {
    const depKey = direction === "outbound" ? "outboundDeparture" : "returnDeparture";
    const bands = slotCols.find((c) => c.columnId === row.columnId)?.bands;
    const sampleId = sampleForDay(bands, direction, day);
    const firstDep = parseHHMM(row[depKey]);
    if (firstDep == null) continue;
    const times = modelledStopTimes(doc, direction, firstDep, sampleId);
    if (!times) continue;
    journeys.push({ id: row.columnId, times });
  }

  if (!journeys.length) return null;
  return {
    heading: dir.label ?? direction,
    stops: stopLabels(doc, direction),
    journeys,
  };
}

export function buildProposedTimetableBoard(
  doc: EngineDocument,
  direction: DirectionName,
  serviceCount: number,
): TimetableBoardModel | null {
  return proposedDirectionBoard(doc, direction, serviceCount);
}

export function buildProposedTimetableBoardGrouped(
  doc: EngineDocument,
  direction: DirectionName,
  serviceCount: number,
): TimetableBoardGroupedModel | null {
  const board = proposedDirectionBoard(doc, direction, serviceCount);
  if (!board?.journeys.length) return null;
  return {
    heading: board.heading,
    stops: board.stops,
    groups: [
      {
        id: "mon-sun",
        label: "Monday to Sunday",
        journeys: board.journeys,
      },
    ],
  };
}

export function buildSuggestedTimetableBoard(
  doc: EngineDocument,
  direction: DirectionName,
  day: "weekday" | "weekend",
  rows: TimetableDisplayRow[],
): TimetableBoardModel | null {
  return suggestedDirectionBoard(doc, direction, day, rows);
}

export function buildSuggestedTimetableBoardGrouped(
  doc: EngineDocument,
  direction: DirectionName,
  weekdayRows: TimetableDisplayRow[],
  weekendRows: TimetableDisplayRow[],
): TimetableBoardGroupedModel | null {
  const weekday = suggestedDirectionBoard(doc, direction, "weekday", weekdayRows);
  const weekend = suggestedDirectionBoard(doc, direction, "weekend", weekendRows);
  if (!weekday && !weekend) return null;

  const stops = weekday?.stops ?? weekend?.stops ?? [];
  const groups: TimetableBoardGroup[] = [];
  if (weekday?.journeys.length) {
    groups.push({
      id: "weekday",
      label: "Monday - Friday",
      journeys: weekday.journeys,
    });
  }
  if (weekend?.journeys.length) {
    groups.push({
      id: "weekend",
      label: "Saturday - Sunday",
      journeys: weekend.journeys,
    });
  }
  if (!groups.length) return null;

  return {
    heading: weekday?.heading ?? weekend?.heading ?? direction,
    stops,
    groups,
  };
}
