export const SERVICE_DIRECTIONS = ["outbound", "return"];

/**
 * Data-driven weekday traffic bands (§1.4). Replaces fixed AM/off/PM classification.
 *
 * Each band has a clock range [start, end) and an apex used as the Google Routes departure.
 * Peak bands use commuter demand weights; valley bands use off-peak gravity weights.
 */

import { parseHHMM } from "../lib/time.js";

/** @typedef {{ id: string, kind: "peak"|"valley", start: string, end: string, apex: string, apexPctPerHour?: number }} TrafficBand */

const round1 = (n) => Math.round(n * 10) / 10;

export function idxToHhmm(i) {
  return `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`;
}

/** Routing sample ids: every band apex + weekend. */
export function routingSampleIds(bands) {
  return [...(bands ?? []).map((b) => b.id), "weekend"];
}

/** Traffic sample ids for one service direction (dynamic band list + weekend). */
export function routingSamplesForDirection(temporalWindows, direction = "outbound") {
  return routingSampleIds(weekdayBands(temporalWindows, direction));
}

/** Deepest valley band — baseline geometry / coach-adjusted reference. Falls back to first band. */
export function baselineSampleId(bands) {
  const valleys = (bands ?? []).filter((b) => b.kind === "valley");
  if (!valleys.length) return bands?.[0]?.id ?? "valley1";
  return valleys.reduce((best, b) => ((b.apexPctPerHour ?? Infinity) < (best.apexPctPerHour ?? Infinity) ? b : best)).id;
}

/** Weekday band clock times for a service direction. Supports legacy flat documents. */
export function weekdayBands(tw, direction = "outbound") {
  if (!tw) return [];
  const dir = tw.outbound && tw.return ? tw[direction] ?? tw.outbound : tw;
  return dir.weekdayBands ?? [];
}

export function weekendDeparture(tw, direction = "outbound") {
  if (!tw) return "11:00";
  const dir = tw.outbound && tw.return ? tw[direction] ?? tw.outbound : tw;
  return dir.weekendDeparture ?? "11:00";
}

/** Weekend peak band for gap qualification (WebTRIS Sat/Sun busy hour). */
export function weekendPeakBand(tw, direction = "outbound") {
  const dir = tw?.outbound && tw?.return ? tw[direction] ?? tw.outbound : tw;
  return dir?.weekendPeakBand;
}

/** Which band a weekday departure (minutes from midnight) falls in. Outside bands → nearest valley or last band. */
export function bandFor(minutes, bands) {
  if (!bands?.length) return "valley1";
  const m = ((minutes % 1440) + 1440) % 1440;
  for (const b of bands) {
    const start = parseHHMM(b.start), end = parseHHMM(b.end);
    if (start == null || end == null) continue;
    if (start <= end) {
      if (m >= start && m < end) return b.id;
    } else if (m >= start || m < end) {
      return b.id;
    }
  }
  const valleys = bands.filter((b) => b.kind === "valley");
  return (valleys[0] ?? bands.at(-1)).id;
}

export function bandById(bands, id) {
  return bands?.find((b) => b.id === id);
}

export function isPeakBand(bands, bandId) {
  return bandById(bands, bandId)?.kind === "peak";
}

/** Human label for UI tables. */
export function bandLabel(band) {
  if (!band) return "–";
  const cap = band.kind === "peak" ? "Peak" : "Valley";
  const n = band.id.replace(/[^\d]/g, "");
  return n ? `${cap} ${n}` : cap;
}

export function bandPeriodLabel(band) {
  if (!band?.start || !band?.end) return "–";
  return `${band.start}–${band.end}`;
}

/** Copy fallback bands to both service directions. */
export function fallbackTemporalWindows(fallback, meta = {}) {
  const base = {
    weekdayBands: (fallback.weekdayBands ?? []).map((b) => ({ ...b })),
    weekendDeparture: fallback.weekendDeparture ?? "11:00",
  };
  return {
    source: "fallback",
    outbound: { ...base, ...meta.outbound },
    return: { ...base, ...meta.return },
  };
}
