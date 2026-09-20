/**
 * Shared WebTRIS basis-site evaluation and selection (temporal + post-route refine).
 */

import {
  dailyReport,
  profile,
  detectBands,
  detectWeekendBusyHour,
  hourlyPercent,
  quarterHourPercent,
} from "../adapters/webtris.js";
import { haversineMetres } from "../lib/geo.js";

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** SRN compass label from a bearing between terminal anchors (degrees). */
export function compassFromBearing(brg) {
  if (brg >= 315 || brg < 45) return "northbound";
  if (brg < 135) return "eastbound";
  if (brg < 225) return "southbound";
  return "westbound";
}

export function oppositeCompass(compass) {
  return (
    { northbound: "southbound", southbound: "northbound", eastbound: "westbound", westbound: "eastbound" }[
      compass
    ] ?? compass
  );
}

/** Weekend peak band for estimatedTemporalWindows from a WebTRIS busy-hour record. */
export function weekendPeakBandFromBusyHour(w) {
  if (!w) return undefined;
  const apex = w.apex ?? w.busyHourStart ?? "11:00";
  if (w.start && w.end && w.start !== w.end) {
    return { id: "weekend", kind: "peak", start: w.start, end: w.end, apex };
  }
  return { id: "weekend", kind: "peak", start: apex, end: apex, apex };
}

/** One direction's temporal windows block after basis-site selection. */
export function directionTemporalWindows(basis, pick, { anchorStopName, compass }) {
  return {
    weekdayBands: basis.weekdayBands,
    profileKind: basis.profileKind,
    weekendDeparture: basis.weekendBusyHour.apex ?? basis.weekendBusyHour.busyHourStart,
    weekendPeakBand: weekendPeakBandFromBusyHour(basis.weekendBusyHour),
    basisSiteId: pick.site.id,
    anchorStopName,
    compass,
  };
}

export function basisSiteIndex(doc, serviceDirection) {
  return doc.trafficProfile?.basisSites?.findIndex((s) => s.serviceDirection === serviceDirection) ?? -1;
}

export function patchBasisRouteDistance(doc, serviceDirection, distanceM) {
  const idx = basisSiteIndex(doc, serviceDirection);
  if (idx >= 0) doc.trafficProfile.basisSites[idx].routeDistanceM = distanceM;
}

export function qualifiesEvaluated(e, cfg) {
  return (
    e.wd.coverage >= cfg.minCoverage &&
    e.we.daysUsed > 0 &&
    e.wd.shares?.length
  );
}

export function rankEvaluated(a, b) {
  return (
    (b.wd.yearsUsed?.length ?? 0) - (a.wd.yearsUsed?.length ?? 0) ||
    b.wd.coverage - a.wd.coverage ||
    b.wd.dayTotal - a.wd.dayTotal
  );
}

/** Nearest qualifying site to the terminal anchor (initial temporal pick). */
export function pickBasisSiteNearAnchor(evaluated, compass, anchor, cfg) {
  const candidates = evaluated.filter((e) => e.site.direction === compass && qualifiesEvaluated(e, cfg));
  if (!candidates.length) return null;
  return candidates.sort(
    (a, b) => haversineMetres(anchor, a.site) - haversineMetres(anchor, b.site) || rankEvaluated(a, b),
  )[0];
}

/**
 * On-route refine: among qualifying sites near the same terminal anchor as the corridor pick,
 * prefer the closest to the driven route (keeps Newcastle/Edinburgh anchoring intent).
 */
export function pickBasisSiteOnRoute(evaluated, compass, anchor, cfg, anchorSlackM = 2000) {
  const candidates = evaluated.filter((e) => e.site.direction === compass && qualifiesEvaluated(e, cfg));
  if (!candidates.length) return null;
  const anchorDist = (e) => haversineMetres(anchor, e.site);
  const bestAnchorM = Math.min(...candidates.map(anchorDist));
  const nearAnchor = candidates.filter((e) => anchorDist(e) <= bestAnchorM + anchorSlackM);
  return nearAnchor.sort(
    (a, b) =>
      (a.site.distanceM ?? Infinity) - (b.site.distanceM ?? Infinity) ||
      anchorDist(a) - anchorDist(b) ||
      rankEvaluated(a, b),
  )[0];
}

export async function evaluateSite(site, windows, excluded, log) {
  const perYear = [];
  for (const w of windows) {
    const rows = await dailyReport(site.id, w.start, w.end, log);
    const wd = profile(rows, [1, 2, 3, 4, 5], excluded);
    const we = profile(rows, [0, 6], excluded);
    perYear.push({ year: w.year, wd, we, rows: rows.length });
  }
  const usable = perYear.filter((y) => y.wd.daysUsed >= 10 && y.we.daysUsed >= 4);
  if (usable.length === 0) {
    return { site, wd: { coverage: 0, daysUsed: 0, dayTotal: 0, shares: [] }, we: { daysUsed: 0, shares: [] }, perYear };
  }
  const wd = {
    shares: usable
      .map((y) => y.wd.shares)
      .reduce((acc, shares) => acc.map((v, i) => v + shares[i] / usable.length), new Array(96).fill(0)),
    coverage: mean(usable.map((y) => y.wd.coverage)),
    daysUsed: usable.reduce((s, y) => s + y.wd.daysUsed, 0),
    dayTotal: Math.round(mean(usable.map((y) => y.wd.dayTotal))),
    yearsUsed: usable.map((y) => y.year),
  };
  const we = {
    shares: usable
      .map((y) => y.we.shares)
      .reduce((acc, shares) => acc.map((v, i) => v + shares[i] / usable.length), new Array(96).fill(0)),
    coverage: mean(usable.map((y) => y.we.coverage)),
    daysUsed: usable.reduce((s, y) => s + y.we.daysUsed, 0),
    dayTotal: Math.round(mean(usable.map((y) => y.we.dayTotal))),
  };
  return {
    site,
    wd,
    we,
    perYear: usable.map((y) => ({
      year: y.year,
      weekdays: y.wd.daysUsed,
      weekendDays: y.we.daysUsed,
      vehPerWeekday: y.wd.dayTotal,
      profile: detectBands(y.wd.shares),
    })),
  };
}

export function basisSiteRecord(serviceDirection, compass, anchorStopName, chosen) {
  const bandProfile = detectBands(chosen.wd.shares);
  const weekendBusyHour = detectWeekendBusyHour(chosen.we.shares);
  return {
    serviceDirection,
    compass,
    anchorStopName,
    id: chosen.site.id,
    name: chosen.site.name.replace(/;.*$/, ""),
    direction: chosen.site.direction,
    lat: chosen.site.lat,
    lng: chosen.site.lng,
    routeDistanceM: chosen.site.distanceM ?? null,
    nearestStop: anchorStopName,
    weekdayCoverage: Math.round(chosen.wd.coverage * 100) / 100,
    vehiclesPerWeekday: chosen.wd.dayTotal,
    vehiclesPerWeekendDay: chosen.we.dayTotal,
    yearsUsed: chosen.wd.yearsUsed ?? null,
    weekdayBands: bandProfile.bands,
    profileKind: bandProfile.profileKind,
    dayMeanPctPerHour: bandProfile.dayMeanPctPerHour,
    weekendBusyHour,
    weekdayHourlyPct: hourlyPercent(chosen.wd.shares),
    weekendHourlyPct: hourlyPercent(chosen.we.shares),
    weekdayQuarterHourPct: quarterHourPercent(chosen.wd.shares),
    weekendQuarterHourPct: quarterHourPercent(chosen.we.shares),
    perYear:
      chosen.perYear?.map((y) => ({
        year: y.year,
        weekdays: y.weekdays,
        vehPerWeekday: y.vehPerWeekday,
        peaks: y.profile.bands.filter((b) => b.kind === "peak").map((b) => b.apex),
        profileKind: y.profile.profileKind,
      })) ?? [],
  };
}

export function applyDirectionBasis(doc, dirName, pick, basis) {
  doc.estimatedTemporalWindows[dirName] = {
    ...doc.estimatedTemporalWindows[dirName],
    weekdayBands: basis.weekdayBands,
    profileKind: basis.profileKind,
    weekendDeparture: basis.weekendBusyHour.apex ?? basis.weekendBusyHour.busyHourStart,
    weekendPeakBand: weekendPeakBandFromBusyHour(basis.weekendBusyHour),
    basisSiteId: pick.site.id,
  };
  const idx = basisSiteIndex(doc, dirName);
  if (idx >= 0) doc.trafficProfile.basisSites[idx] = basis;
}

export function refreshWeekendRatio(doc) {
  const sites = doc.trafficProfile?.basisSites ?? [];
  const wkTot = sites.reduce((s, b) => s + (b.vehiclesPerWeekday ?? 0), 0);
  const weTot = sites.reduce((s, b) => s + (b.vehiclesPerWeekendDay ?? 0), 0);
  doc.trafficProfile.weekendToWeekdayVolumeRatio = wkTot > 0 ? Math.round((weTot / wkTot) * 100) / 100 : null;
}
