/**
 * Peak-filtered market openings (DESIGN_DOC §4.4).
 *
 * A market opening is an interior BODS headway gap whose overlap with a WebTRIS peak band
 * is at least the configured threshold. Edge gaps and valley-only holes are excluded.
 * Unserved pairs (no competitor departures) treat peak bands themselves as openings.
 */

import { parseHHMM, formatHHMM } from "../lib/time.js";
import { weekdayBands } from "./traffic-bands.js";
import { headwayGaps, DEFAULT_DAY_START_MIN, DEFAULT_DAY_END_MIN } from "./headway.js";

/** @typedef {{ id?: string, kind?: string, start: string, end: string, apex?: string }} PeakBand */

/**
 * Peak bands for gap qualification — weekday peak1/peak2 or weekend busy band.
 * @param {object} tw estimatedTemporalWindows
 * @param {object} [trafficProfile]
 * @param {"outbound"|"return"} direction
 * @param {"weekday"|"weekend"|"saturday"|"sunday"} dayType
 * @returns {PeakBand[]}
 */
export function peakBandsForDirection(tw, trafficProfile, direction, dayType) {
  const dir = tw?.outbound && tw?.return ? tw[direction] ?? tw.outbound : tw;
  if (dayType === "weekend" || dayType === "saturday" || dayType === "sunday") {
    if (dir?.weekendPeakBand?.start && dir?.weekendPeakBand?.end) return [dir.weekendPeakBand];
    const site = trafficProfile?.basisSites?.find((s) => s.compass === direction);
    const w = site?.weekendBusyHour;
    if (w?.start && w?.end) {
      return [{ id: "weekend", kind: "peak", start: w.start, end: w.end, apex: w.apex ?? w.busyHourStart }];
    }
    const apex = dir?.weekendDeparture ?? "11:00";
    return [{ id: "weekend", kind: "peak", start: apex, end: apex, apex }];
  }
  return weekdayBands(tw, direction).filter((b) => b.kind === "peak");
}

/**
 * Overlap of a gap [gapStart, gapEnd) with each peak band.
 * @returns {Array<{ start: number, end: number, minutes: number }>}
 */
export function intersectGapWithBands(gapStartMin, gapEndMin, peakBands) {
  const out = [];
  for (const b of peakBands ?? []) {
    const bandStart = parseHHMM(b.start);
    const bandEnd = parseHHMM(b.end);
    if (bandStart == null || bandEnd == null) continue;
    const start = Math.max(gapStartMin, bandStart);
    const end = Math.min(gapEndMin, bandEnd);
    if (end > start) out.push({ start, end, minutes: end - start });
  }
  return out;
}

/**
 * Scoring openings: interior gap ∩ peak ≥ threshold, or peak bands for unserved pairs.
 * @param {Array<{ gapStart?: string, gapEnd?: string, start?: number, end?: number, isEdge?: boolean, edge?: boolean }>} rawGaps
 * @param {PeakBand[]} peakBands
 * @param {number} thresholdMin
 * @param {{ excludeEdges?: boolean, unserved?: boolean }} [opts]
 * @returns {Array<{ start: number, end: number, minutes: number, isMarketOpening: boolean, edge?: boolean }>}
 */
export function qualifyMarketOpenings(rawGaps, peakBands, thresholdMin, { excludeEdges = true, unserved = false } = {}) {
  if (unserved) {
    return openingsFromPeakBands(peakBands, thresholdMin);
  }
  const openings = [];
  for (const g of rawGaps) {
    const isEdge = g.isEdge ?? g.edge ?? false;
    if (excludeEdges && isEdge) continue;
    const gapStart = g.gapStart != null ? parseHHMM(g.gapStart) : g.start;
    const gapEnd = g.gapEnd != null ? parseHHMM(g.gapEnd) : g.end;
    if (gapStart == null || gapEnd == null) continue;
    for (const inter of intersectGapWithBands(gapStart, gapEnd, peakBands)) {
      if (inter.minutes >= thresholdMin) {
        openings.push({ ...inter, isMarketOpening: true, edge: false });
      }
    }
  }
  return openings;
}

/** Unserved pairs: each peak band longer than threshold is an opening. */
function openingsFromPeakBands(peakBands, thresholdMin) {
  const openings = [];
  for (const b of peakBands ?? []) {
    const start = parseHHMM(b.start);
    const end = parseHHMM(b.end);
    if (start == null || end == null) continue;
    const minutes = end - start;
    if (minutes > thresholdMin) openings.push({ start, end, minutes, isMarketOpening: true, edge: false });
  }
  return openings;
}

/**
 * Mark raw headway gaps with isMarketOpening when a peak intersection qualifies.
 * @returns {Array<{ gapStart: string, gapEnd: string, durationMinutes: number, isMarketOpening: boolean, isEdge: boolean, peakOverlapMinutes?: number }>}
 */
export function annotateRawGaps(rawGaps, peakBands, thresholdMin, { excludeEdges = true, unserved = false } = {}) {
  if (unserved) {
    return openingsFromPeakBands(peakBands, thresholdMin).map((o) => ({
      gapStart: formatHHMM(o.start),
      gapEnd: formatHHMM(o.end),
      durationMinutes: o.minutes,
      isMarketOpening: true,
      isEdge: false,
      peakOverlapMinutes: o.minutes,
    }));
  }
  return rawGaps.map((g) => {
    const isEdge = g.isEdge ?? false;
    if (excludeEdges && isEdge) {
      return { ...g, isMarketOpening: false, peakOverlapMinutes: 0 };
    }
    const gapStart = parseHHMM(g.gapStart);
    const gapEnd = parseHHMM(g.gapEnd);
    let peakOverlapMinutes = 0;
    for (const inter of intersectGapWithBands(gapStart, gapEnd, peakBands)) {
      if (inter.minutes >= thresholdMin) peakOverlapMinutes = Math.max(peakOverlapMinutes, inter.minutes);
    }
    return { ...g, isMarketOpening: peakOverlapMinutes >= thresholdMin, peakOverlapMinutes };
  });
}

/**
 * Raw headway gaps plus peak-qualified scoring openings for one pair timeline.
 * @param {number[]} timestamps
 * @param {PeakBand[]} peakBands
 * @param {number} thresholdMin
 * @param {number} [dayStart]
 * @param {number} [dayEnd]
 * @returns {{ rawGaps: ReturnType<typeof headwayGaps>, scoringGaps: ReturnType<typeof qualifyMarketOpenings>, schemaGaps: ReturnType<typeof annotateRawGaps> }}
 */
export function gapsForTimeline(timestamps, peakBands, thresholdMin, dayStart = DEFAULT_DAY_START_MIN, dayEnd = DEFAULT_DAY_END_MIN) {
  const unserved = timestamps.length === 0;
  const rawGaps = headwayGaps(timestamps, { thresholdMinutes: thresholdMin, dayStartMin: dayStart, dayEndMin: dayEnd });
  const schemaGaps = annotateRawGaps(rawGaps, peakBands, thresholdMin, { unserved });
  const scoringGaps = qualifyMarketOpenings(rawGaps, peakBands, thresholdMin, { unserved });
  return { rawGaps, scoringGaps, schemaGaps };
}

/** Convert minute-based scoring gaps to the shape used by timetable-selection. */
export function toSelectionGaps(scoringGaps) {
  return scoringGaps.map((g) => ({
    start: g.start,
    end: g.end,
    minutes: g.minutes,
    isMarketOpening: g.isMarketOpening,
    edge: g.edge ?? false,
  }));
}
