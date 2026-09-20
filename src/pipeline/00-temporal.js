/**
 * Step 2 — TEMPORAL WINDOWS (DESIGN_DOC §1.4, flow step 2). Runs before topology so the Google
 * departure times use observed peaks.
 *
 * 1. Build a corridor line from the outbound stops (interpolated every ~2 km).
 * 2. From active WebTRIS sites on the corridor within `radiusM`, pick one basis counter per
 *    service direction: nearest qualifying site to the terminal anchor (Newcastle for outbound,
 *    Edinburgh for return — Edinburgh has no counters, so the nearest southbound English site applies).
 * 3. Pull 15-minute volumes for the configured period; detect traffic bands on each basis site.
 * 4. Write estimatedTemporalWindows.outbound / .return and a slim trafficProfile.
 *
 * Step 2b (refine-basis) may re-pick counters once the Google route polyline exists.
 *
 * Any failure falls back to the configured windows with source: fallback, and says so.
 *
 * @format
 */

import { listSites, sitesNear, seasonalWindows, excludedDates } from "../adapters/webtris.js";
import { estimatedLaunchDate, fallbackTemporalWindows } from "../domain/temporal-windows.js";
import { isPassenger } from "../domain/document.js";
import { haversineMetres } from "../lib/geo.js";
import {
  basisSiteRecord,
  compassFromBearing,
  directionTemporalWindows,
  evaluateSite,
  oppositeCompass,
  pickBasisSiteNearAnchor,
  refreshWeekendRatio,
} from "../domain/traffic-basis.js";
import { bearingDeg } from "../adapters/naptan.js";
import { CacheMiss } from "../lib/cache.js";

export const name = "temporal";

export async function run(ctx) {
  const { document: doc, config, log } = ctx;
  const cfg = config.traffic;
  try {
    await compute(ctx, cfg);
  } catch (err) {
    const soft = err instanceof CacheMiss || /WebTRIS/.test(err.message);
    if (!soft) throw err;
    log.warn(
      { reason: err.message },
      "temporal windows: WebTRIS unavailable — using fallback windows",
    );
    doc.estimatedTemporalWindows = fallbackTemporalWindows(
      config.engine.fallbackTemporalWindows,
    );
    doc.trafficProfile = {
      source: "fallback",
      period: {
        launchDate: estimatedLaunchDate(new Date(), config.traffic.launchLeadDays),
        launchLeadDays: config.traffic.launchLeadDays,
        windowMonths: config.traffic.windowMonths,
      },
    };
  }
  return ctx;
}

function corridorPoints(stops, stepM = 2000) {
  const pts = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i].coordinates,
      b = stops[i + 1].coordinates;
    const d = haversineMetres(a, b);
    const n = Math.max(1, Math.round(d / stepM));
    for (let k = 0; k < n; k++)
      pts.push({
        lat: a.lat + ((b.lat - a.lat) * k) / n,
        lng: a.lng + ((b.lng - a.lng) * k) / n,
      });
  }
  pts.push(stops.at(-1).coordinates);
  return pts;
}

async function compute(ctx, cfg) {
  const { document: doc, log } = ctx;
  const outStops = doc.directions.outbound.orderedStops;
  const pax = outStops.filter(isPassenger);
  if (pax.length < 2)
    throw new Error("temporal windows need at least two passenger stops");
  const points = corridorPoints(outStops);
  const anchorOutbound = pax[0].coordinates;
  const anchorReturn = pax.at(-1).coordinates;

  const outboundCompass = compassFromBearing(bearingDeg(anchorOutbound, anchorReturn));
  const returnCompass = oppositeCompass(outboundCompass);

  let windows,
    launchDate = null;
  if (cfg.periodStart) {
    const start = new Date(`${cfg.periodStart}T00:00:00Z`);
    const end = new Date(start.getTime() + (cfg.weeks * 7 - 1) * 86400_000);
    windows = [
      {
        start,
        end,
        year: start.getUTCFullYear(),
        label: `${cfg.periodStart} +${cfg.weeks}w`,
      },
    ];
  } else {
    const sw = seasonalWindows({
      today: cfg.referenceDate ? new Date(`${cfg.referenceDate}T12:00:00Z`) : undefined,
      leadDays: cfg.launchLeadDays,
      months: cfg.windowMonths,
      years: cfg.historyYears,
    });
    windows = sw.windows;
    launchDate = sw.launchDate;
  }
  const excluded = excludedDates(windows, cfg.bankHolidays, cfg.excludeChristmas);

  const all = await listSites(log);
  const near = sitesNear(
    all,
    points,
    cfg.siteRadiusM,
    new RegExp(cfg.roadRegex, "i"),
  ).filter((s) => /active/i.test(s.status) && s.direction);
  const segLo = near.length ? Math.min(...near.map((s) => s.nearestPointIndex)) : 0;
  const segHi = near.length
    ? Math.max(...near.map((s) => s.nearestPointIndex))
    : points.length - 1;
  const coveredKm = Math.round((segHi - segLo + 1) * 2);
  log.info(
    {
      candidates: near.length,
      windowMonths: cfg.periodStart ? null : cfg.windowMonths,
      launchDate,
      leadDays: cfg.periodStart ? null : cfg.launchLeadDays,
      outboundCompass,
      returnCompass,
      coveredCorridorKm: coveredKm,
      ofKm: points.length * 2,
    },
    "webtris candidate sites",
  );

  const evaluated = [];
  for (const s of near) {
    evaluated.push(await evaluateSite(s, windows, excluded, log));
  }
  if (!evaluated.length) throw new Error("WebTRIS: no candidate sites on the corridor");

  ctx.trafficEvaluated = evaluated;
  ctx.trafficWindows = windows;
  ctx.trafficExcluded = excluded;

  const outboundPick = pickBasisSiteNearAnchor(
    evaluated,
    outboundCompass,
    anchorOutbound,
    cfg,
  );
  const returnPick = pickBasisSiteNearAnchor(evaluated, returnCompass, anchorReturn, cfg);
  if (!outboundPick || !returnPick)
    throw new Error(
      "WebTRIS: no qualifying basis site for outbound or return terminal anchor",
    );

  const outboundBasis = basisSiteRecord(
    "outbound",
    outboundCompass,
    pax[0].stopName,
    outboundPick,
  );
  const returnBasis = basisSiteRecord(
    "return",
    returnCompass,
    pax.at(-1).stopName,
    returnPick,
  );

  doc.estimatedTemporalWindows = {
    source: "webtris",
    outbound: directionTemporalWindows(outboundBasis, outboundPick, {
      anchorStopName: pax[0].stopName,
      compass: outboundCompass,
    }),
    return: directionTemporalWindows(returnBasis, returnPick, {
      anchorStopName: pax.at(-1).stopName,
      compass: returnCompass,
    }),
  };

  doc.trafficProfile = {
    source:
      "National Highways WebTRIS (England SRN); terminal-anchored basis sites per direction",
    period: {
      launchDate,
      launchLeadDays: cfg.periodStart ? null : cfg.launchLeadDays,
      windowMonths: cfg.periodStart ? null : cfg.windowMonths,
      windows: windows.map((w) => ({
        year: w.year,
        start: w.label.split("..")[0],
        end: w.label.split("..")[1] ?? null,
      })),
      excludedDates: excluded.size,
    },
    coverage: { corridorKmWithSites: coveredKm, corridorKmTotal: points.length * 2 },
    outboundCompassDirection: outboundCompass,
    basisSites: [outboundBasis, returnBasis],
    weekendToWeekdayVolumeRatio: null,
  };
  refreshWeekendRatio(doc);

  log.info(
    {
      outbound: doc.estimatedTemporalWindows.outbound,
      return: doc.estimatedTemporalWindows.return,
      basisSites: [outboundPick.site.id, returnPick.site.id],
      weekendRatio: doc.trafficProfile.weekendToWeekdayVolumeRatio,
    },
    "temporal windows from webtris",
  );
}
