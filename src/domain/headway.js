/**
 * Headway gap calculation (DESIGN_DOC §4.4). Pure.
 *
 * Given the sorted departure timestamps of competing services for one directional pair over a
 * service day, return the gaps between consecutive departures plus the two edge gaps (start of the
 * analysed day → first departure, last departure → end of day). A gap longer than the threshold is a
 * Market Opening. Times are service-day minutes (see src/lib/time.js; "25:22" = 01:22 next day).
 */

import { formatHHMM } from "../lib/time.js";

export const DEFAULT_DAY_START_MIN = 5 * 60; // 05:00
export const DEFAULT_DAY_END_MIN = 23 * 60; // 23:00

/**
 * @param {number[]} timestampsMin  departures at the pair's origin (any order, duplicates allowed)
 * @param {{ thresholdMinutes: number, dayStartMin?: number, dayEndMin?: number, includeEdges?: boolean }} opts
 * @returns {Array<{ gapStart: string, gapEnd: string, durationMinutes: number, isMarketOpening: boolean, isEdge: boolean }>}
 */
export function headwayGaps(timestampsMin, opts) {
  const threshold = opts?.thresholdMinutes;
  if (!Number.isFinite(threshold)) throw new TypeError("thresholdMinutes is required");
  const dayStart = opts.dayStartMin ?? DEFAULT_DAY_START_MIN;
  const dayEnd = opts.dayEndMin ?? DEFAULT_DAY_END_MIN;
  const includeEdges = opts.includeEdges ?? true;

  const times = [...new Set(timestampsMin.map((t) => Math.round(t)))].sort((a, b) => a - b);
  const gap = (from, to, isEdge) => ({
    gapStart: formatHHMM(from),
    gapEnd: formatHHMM(to),
    durationMinutes: to - from,
    isMarketOpening: to - from > threshold,
    isEdge,
  });

  if (times.length === 0) return [gap(dayStart, dayEnd, true)];

  const gaps = [];
  if (includeEdges && times[0] > dayStart) gaps.push(gap(dayStart, times[0], true));
  for (let i = 1; i < times.length; i++) gaps.push(gap(times[i - 1], times[i], false));
  if (includeEdges && times[times.length - 1] < dayEnd) gaps.push(gap(times[times.length - 1], dayEnd, true));
  return gaps;
}

/** Schema-shaped copy (`gapStart, gapEnd, durationMinutes, isMarketOpening`) for supplyVector.calculatedHeadwayGaps. */
export const toSchemaGaps = (gaps) => gaps.map(({ gapStart, gapEnd, durationMinutes, isMarketOpening }) => ({ gapStart, gapEnd, durationMinutes, isMarketOpening }));

/** Summary numbers for a gap list. */
export function summariseGaps(gaps) {
  const openings = gaps.filter((g) => g.isMarketOpening);
  return {
    gaps: gaps.length,
    marketOpenings: openings.length,
    openingMinutes: openings.reduce((s, g) => s + g.durationMinutes, 0),
    longestGapMinutes: gaps.reduce((m, g) => Math.max(m, g.durationMinutes), 0),
  };
}
