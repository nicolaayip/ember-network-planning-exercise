/**
 * National Highways WebTRIS adapter (DESIGN_DOC §1.4). England SRN only.
 *
 *   GET /api/v1/sites                      -> all count sites (id, name, description, lat/lng, status)
 *   GET /api/v1/reports/daily?sites=..&start_date=DDMMYYYY&end_date=DDMMYYYY&page=&page_size=
 *                                          -> 15-minute rows: "Report Date", "Time Period Ending", "Total Volume", ...
 *
 * All fetches go through the disk cache (key = endpoint + params), so a re-run costs nothing
 * and MOCK=true is served from cache. Pure profile/peak functions live here too and are unit-tested
 * (test/adapters/webtris.test.js). Consumed by src/pipeline/02-temporal.js.
 *
 * OWNERSHIP: this file is maintained by the pipeline/engine agent. Please do not replace it; add
 * functions alongside. Known idea to merge from a parallel draft: latestCompleteWeek() — choose the
 * most recent 4-week window whose data is complete instead of a fixed configured period.
 */

import { config } from "../config.js";
import { estimatedLaunchDate } from "../domain/temporal-windows.js";
import { idxToHhmm } from "../domain/traffic-bands.js";
import { cached } from "../lib/cache.js";
import { http, withRetry, describeHttpError } from "../lib/http.js";
import { haversineMetres } from "../lib/geo.js";

const base = () => config.endpoints.webtris;

async function getJson(pathname, params, log) {
  const { value } = await cached("webtris", { pathname, params }, async () => {
    try {
      const res = await withRetry(() => http.get(`${base()}${pathname}`, { params }), { log });
      return res.data;
    } catch (err) {
      throw new Error(`WebTRIS ${pathname}: ${describeHttpError(err)}`);
    }
  });
  return value;
}

/** @typedef {{ id: number, name: string, description: string, lat: number, lng: number, status: string }} Site */

/** All WebTRIS sites (~20k). Cached. */
export async function listSites(log) {
  const data = await getJson("/sites", {}, log);
  return (data.sites ?? []).map((s) => ({
    id: Number(s.Id),
    name: s.Name ?? "",
    description: s.Description ?? "",
    lat: Number(s.Latitude),
    lng: Number(s.Longitude),
    status: s.Status ?? "",
  }));
}

/**
 * Sites within `radiusM` of any of `points`, optionally filtered by a road regex on name/description.
 * Each result carries the nearest point index and distance, and a best-effort direction.
 */
export function sitesNear(sites, points, radiusM = 1500, roadRegex = /\bA1\b|A1\(M\)/i) {
  const out = [];
  for (const s of sites) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const text = `${s.name} ${s.description}`;
    if (roadRegex && !roadRegex.test(text)) continue;
    let best = { i: -1, d: Infinity };
    points.forEach((p, i) => {
      const d = haversineMetres(p, s);
      if (d < best.d) best = { i, d };
    });
    if (best.d <= radiusM) out.push({ ...s, nearestPointIndex: best.i, distanceM: Math.round(best.d), direction: directionOf(text) });
  }
  return out.sort((a, b) => a.nearestPointIndex - b.nearestPointIndex || a.distanceM - b.distanceM);
}

export function directionOf(text) {
  const m = /\b(north|south|east|west)bound\b/i.exec(text) ?? /\b(NB|SB|EB|WB)\b/.exec(text);
  if (!m) return null;
  const t = m[1].toLowerCase();
  return { north: "northbound", south: "southbound", east: "eastbound", west: "westbound", nb: "northbound", sb: "southbound", eb: "eastbound", wb: "westbound" }[t] ?? null;
}

const ddmmyyyy = (d) => `${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${d.getUTCFullYear()}`;

/**
 * 15-minute rows for a site between two dates (inclusive), all pages. Cached per page.
 * @returns {Promise<Array<{ date: string, timeEnding: string, minutesEnding: number, weekday: number, totalVolume: number|null }>>}
 */
export async function dailyReport(siteId, startDate, endDate, log) {
  const rows = [];
  const pageSize = 10000;
  for (let page = 1; page < 50; page++) {
    let data;
    try {
      data = await getJson("/reports/daily", { sites: siteId, start_date: ddmmyyyy(startDate), end_date: ddmmyyyy(endDate), page, page_size: pageSize }, log);
    } catch (err) {
      // WebTRIS returns 204 No Content (empty body) when a page is out of range or the site has no data.
      if (/HTTP 204/.test(err.message)) break;
      throw err;
    }
    const batch = data?.Rows ?? [];
    for (const r of batch) {
      const date = r["Report Date"]?.slice(0, 10); // "2026-06-01T00:00:00"
      const timeEnding = r["Time Period Ending"]; // "00:14:00"
      const vol = r["Total Volume"];
      const [hh, mm] = timeEnding.split(":").map(Number);
      const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
      rows.push({ date, timeEnding, minutesEnding: hh * 60 + mm + 1, weekday: wd, totalVolume: vol === "" || vol === null || vol === undefined ? null : Number(vol) });
    }
    if (batch.length < pageSize) break;
  }
  return rows;
}

/**
 * Normalised 24h profile from rows: per 15-min interval, mean of Total Volume across days of the
 * given weekday set, then divided by the day total so sites of different size are comparable.
 * @param {Array} rows from dailyReport
 * @param {number[]} weekdays  e.g. [1,2,3,4,5]
 * @returns {{ shares: number[], means: number[], daysUsed: number, coverage: number, dayTotal: number }}
 */
export function profile(rows, weekdays, excludeDates = new Set()) {
  const byDay = new Map();
  for (const r of rows) {
    if (!weekdays.includes(r.weekday) || r.totalVolume === null || excludeDates.has(r.date)) continue;
    if (!byDay.has(r.date)) byDay.set(r.date, new Array(96).fill(null));
    const idx = Math.min(95, Math.floor((r.minutesEnding - 1) / 15));
    byDay.get(r.date)[idx] = r.totalVolume;
  }
  // Keep only days with reasonably complete data (≥ 90 of 96 intervals)
  const days = [...byDay.values()].filter((d) => d.filter((v) => v !== null).length >= 90);
  const means = new Array(96).fill(0);
  for (let i = 0; i < 96; i++) {
    const vals = days.map((d) => d[i]).filter((v) => v !== null);
    means[i] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const dayTotal = means.reduce((a, b) => a + b, 0);
  const shares = means.map((m) => (dayTotal ? m / dayTotal : 0));
  const expectedDays = new Set(rows.filter((r) => weekdays.includes(r.weekday) && !excludeDates.has(r.date)).map((r) => r.date)).size;
  return { shares, means: means.map(Math.round), daysUsed: days.length, coverage: expectedDays ? days.length / expectedDays : 0, dayTotal: Math.round(dayTotal) };
}

/**
 * Seasonally aligned analysis windows (DESIGN_DOC §1.4): the launch window (today + leadDays, for
 * `months` months) shifted back 1..years years. Returns [{ start, end, year }] oldest first.
 */
export function seasonalWindows({ today = new Date(), leadDays, months, years }) {
  const launchIso = estimatedLaunchDate(today, leadDays);
  const [y, mo, da] = launchIso.split("-").map(Number);
  const launch = new Date(Date.UTC(y, mo - 1, da));
  const out = [];
  for (let k = years; k >= 1; k--) {
    const start = new Date(Date.UTC(launch.getUTCFullYear() - k, launch.getUTCMonth(), launch.getUTCDate()));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate() - 1));
    out.push({ start, end, year: start.getUTCFullYear(), label: `${iso(start)}..${iso(end)}` });
  }
  return { launchDate: launchIso, windows: out };
}

const iso = (d) => d.toISOString().slice(0, 10);

/** Dates to exclude from profiles: bank holidays + (optionally) Dec 20 – Jan 5 around each year end. */
export function excludedDates(windows, bankHolidays = [], excludeChristmas = true) {
  const set = new Set(bankHolidays);
  if (excludeChristmas) {
    for (const w of windows) {
      for (const y of new Set([w.start.getUTCFullYear(), w.end.getUTCFullYear()])) {
        for (let d = new Date(Date.UTC(y - 1, 11, 20)); d <= new Date(Date.UTC(y, 0, 5)); d.setUTCDate(d.getUTCDate() + 1)) set.add(iso(d));
        for (let d = new Date(Date.UTC(y, 11, 20)); d <= new Date(Date.UTC(y + 1, 0, 5)); d.setUTCDate(d.getUTCDate() + 1)) set.add(iso(d));
      }
    }
  }
  return set;
}

/**
 * Weekday traffic bands from a 96-interval share profile.
 * Local maxima (prominence + min spacing) on the 75-minute smoothed series; peak band edges are
 * where traffic crosses flankFraction of the apex on the rising and falling flanks (within trough
 * bounds). Valleys fill the gaps between peaks. Apex = Google Routes departure sample.
 */
export function detectBands(shares, { searchFrom = 5, searchTo = 22, minPeakSpacing = 12, minProminence = 0.06, minTroughDrop = 0.05, flankFraction = 0.8 } = {}) {
  const smooth = smoothShares(shares);
  const from = searchFrom * 4;
  const to = searchTo * 4;
  const hhmm = (i) => idxToHhmm(i);
  const endHhmm = (i) => hhmm(Math.min(i, to));
  const pctPerHour = (i) => round1(smooth[i] * 4 * 100);
  const argmax = (a, b) => { let best = a; for (let i = a; i < b; i++) if (smooth[i] > smooth[best]) best = i; return best; };
  const argmin = (a, b) => { let best = a; for (let i = a; i < b; i++) if (smooth[i] < smooth[best]) best = i; return best; };
  const midIdx = (a, b) => Math.round((a + b) / 2);

  const segment = smooth.slice(from, to);
  const lo = Math.min(...segment);
  const hi = Math.max(...segment);
  const threshold = lo + minProminence * (hi - lo);

  const candidates = [];
  for (let i = from + 1; i < to - 1; i++) {
    if (smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1] && smooth[i] >= threshold) candidates.push(i);
  }
  let peaks = [];
  for (const idx of candidates.sort((a, b) => smooth[b] - smooth[a])) {
    if (peaks.every((p) => Math.abs(p - idx) >= minPeakSpacing)) peaks.push(idx);
  }
  peaks.sort((a, b) => a - b);
  peaks = mergeShallowPeaks(peaks, smooth, minTroughDrop);

  const dayMeanPctPerHour = round1((segment.reduce((a, b) => a + b, 0) / segment.length) * 4 * 100);

  if (peaks.length === 0) {
    const maxI = argmax(from, to);
    const flank = flankBounds(maxI, from, to - 1, smooth, flankFraction);
    return {
      bands: [{ id: "peak1", kind: "peak", start: hhmm(flank.start), end: endHhmm(flank.endExclusive), apex: hhmm(maxI), apexPctPerHour: pctPerHour(maxI) }],
      profileKind: "flat",
      dayMeanPctPerHour,
    };
  }

  const peakBands = peaks.map((p, pi) => {
    const left = pi === 0 ? from : argmin(peaks[pi - 1], p);
    const troughRight = pi === peaks.length - 1 ? to - 1 : argmin(p, peaks[pi + 1]);
    // Cap the falling flank at the trough midpoint so a shoulder that never drops below 80%
    // does not swallow the intervening valley (e.g. outbound AM peak vs lunch dip).
    const fallLimit = pi === peaks.length - 1 ? to - 1 : midIdx(p, troughRight);
    const flank = flankBounds(p, left, fallLimit, smooth, flankFraction);
    return { p, start: flank.start, endExclusive: flank.endExclusive, apexPctPerHour: pctPerHour(p) };
  });

  const bands = [];
  let peakN = 0;
  let valleyN = 0;
  for (let i = 0; i < peakBands.length; i++) {
    peakN++;
    const pb = peakBands[i];
    bands.push({ id: `peak${peakN}`, kind: "peak", start: hhmm(pb.start), end: endHhmm(pb.endExclusive), apex: hhmm(pb.p), apexPctPerHour: pb.apexPctPerHour });
    if (i < peakBands.length - 1) {
      const next = peakBands[i + 1];
      const trough = argmin(pb.p, next.p);
      valleyN++;
      bands.push({
        id: `valley${valleyN}`,
        kind: "valley",
        start: endHhmm(pb.endExclusive),
        end: hhmm(next.start),
        apex: hhmm(trough),
        apexPctPerHour: pctPerHour(trough),
      });
    }
  }

  const profileKind = peaks.length >= 2 ? "dual_peak" : peaks.length === 1 && (hi - lo) / hi < 0.12 ? "plateau" : "single_peak";
  return { bands, profileKind, dayMeanPctPerHour };
}

/**
 * Peak band edges at flankFraction of apex height — symmetric on rising and falling flanks.
 * Returns [start, endExclusive) interval indices within [left, right].
 */
function flankBounds(apexIdx, left, right, smooth, flankFraction) {
  const thresh = smooth[apexIdx] * flankFraction;
  let start = apexIdx;
  for (let i = left; i <= apexIdx; i++) {
    if (smooth[i] >= thresh) { start = i; break; }
  }
  let end = apexIdx;
  for (let i = right; i >= apexIdx; i--) {
    if (smooth[i] >= thresh) { end = i; break; }
  }
  return { start, endExclusive: end + 1 };
}

/** Merge consecutive peaks when the trough between them is less than minTroughDrop below the lower peak. */
function mergeShallowPeaks(peaks, smooth, minTroughDrop) {
  if (peaks.length <= 1) return peaks;
  let groups = peaks.map((p) => [p]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < groups.length - 1; i++) {
      const leftPeak = groups[i][0];
      const rightPeak = groups[i + 1][groups[i + 1].length - 1];
      const trough = argminBetween(leftPeak, rightPeak, smooth);
      const lowerPeak = Math.min(smooth[leftPeak], smooth[rightPeak]);
      if (smooth[trough] >= lowerPeak * (1 - minTroughDrop)) {
        groups[i] = [...groups[i], ...groups[i + 1]];
        groups.splice(i + 1, 1);
        changed = true;
        break;
      }
    }
  }
  return groups.map((g) => g.reduce((best, p) => (smooth[p] > smooth[best] ? p : best), g[0]));
}

function argminBetween(a, b, values) {
  let best = a;
  for (let i = a; i <= b; i++) if (values[i] < values[best]) best = i;
  return best;
}

/**
 * Weekend leisure peak on a Sat/Sun profile — wider flank band than weekday (default 60% of apex)
 * because leisure traffic is flatter; searched within [searchFrom, searchTo).
 * Returns the dominant peak band; apex = Google Routes sample.
 */
export function detectWeekendBusyHour(shares, { searchFrom = 8, searchTo = 18, flankFraction = 0.6 } = {}) {
  const { bands, profileKind } = detectBands(shares, { searchFrom, searchTo, flankFraction });
  const peaks = bands.filter((b) => b.kind === "peak");
  const peak = peaks.sort((a, b) => (b.apexPctPerHour ?? 0) - (a.apexPctPerHour ?? 0))[0] ?? bands[0];
  const smooth = smoothShares(shares);
  const from = searchFrom * 4;
  const to = searchTo * 4;
  const segment = smooth.slice(from, to);
  const dayMean = segment.reduce((a, b) => a + b, 0) / segment.length;
  const apexIdx = peak?.apex ? hhmmToIdx(peak.apex) : null;
  const apexShare = apexIdx != null ? smooth[apexIdx] : dayMean;
  const windowShare = peak?.start && peak?.end
    ? smooth.slice(hhmmToIdx(peak.start) ?? from, (hhmmToIdx(peak.end) ?? to - 1) + 1).reduce((a, b) => a + b, 0)
    : apexShare * 4;
  return {
    start: peak?.start,
    end: peak?.end,
    apex: peak?.apex,
    busyHourStart: peak?.apex,
    apexPctPerHour: peak?.apexPctPerHour,
    profileKind,
    pctOfDay: round1(windowShare * 100),
    pctPerHour: peak?.apexPctPerHour ?? round1(apexShare * 4 * 100),
    vsDayMean: dayMean > 0 ? round2(apexShare / dayMean) : null,
  };
}

function hhmmToIdx(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 4 + Math.floor(Number(m[2]) / 15);
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/** Hourly percentage-of-day series (24 values) from a 96-interval share profile. */
export function hourlyPercent(shares) {
  return Array.from({ length: 24 }, (_, h) => round1(shares.slice(h * 4, h * 4 + 4).reduce((a, b) => a + b, 0) * 100));
}

function smoothShares(shares) {
  return shares.map((_, i) => {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < 96) { s += shares[j]; n++; }
    }
    return s / n;
  });
}

/** 15-minute % of daily flow (96 values), 75-minute smoothed — matches detectBands input. */
export function quarterHourPercent(shares) {
  return smoothShares(shares).map((s) => round2(s * 100));
}

/** Average several share profiles (equal weight). */
export function averageShares(profiles) {
  const n = profiles.length;
  const out = new Array(96).fill(0);
  for (const p of profiles) for (let i = 0; i < 96; i++) out[i] += p.shares[i] / n;
  return out;
}
