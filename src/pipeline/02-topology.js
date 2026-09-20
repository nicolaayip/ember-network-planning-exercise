/**
 * Step 3 — TOPOLOGY (DESIGN_DOC §2.2, flow step 3).
 *
 * For each direction and each traffic sample (detected band apex + weekend) call Google
 * Routes with the stops as intermediates. Produces ctx.legs[direction] = per-leg objects with
 * distanceKm and per-sample duration / staticDuration, plus ctx.routeGeometry[direction] for
 * later use (WebTRIS site selection, dashboard map).
 *
 * Also computes per-stop deviation inputs: baseline route WITHOUT each intermediate passenger
 * stop (one extra Google call per skip, cached). Coach free-flow deviation is finished in
 * velocity once per-leg carriageway factors exist (§2.3).
 *
 * The depot (role=depot, first point outbound / last point return) is routed like any other point,
 * so legs[0] outbound / legs.at(-1) return are the dead legs (§5.1). It has no deviation (it is
 * not optional) and the terminals adjacent to it are still terminals, not intermediates.
 */

import { computeRoute, departureForSample, departureIso, resolveLaunchDate } from "../adapters/google-routes.js";
import { baselineSampleId, routingSampleIds, weekdayBands } from "../domain/traffic-bands.js";
import { CacheMiss } from "../lib/cache.js";
import { isPassenger } from "../domain/document.js";

export const name = "topology";

export async function run(ctx) {
  try {
    return await compute(ctx);
  } catch (err) {
    // No key and no cache → downstream steps fall back to placeholders and say so.
    if (err instanceof CacheMiss || /GOOGLE_MAPS_API_KEY is not set/.test(err.message)) {
      ctx.log.warn({ reason: err.message }, "topology skipped — Google Routes unavailable; placeholders will be used");
      delete ctx.legs; delete ctx.routeGeometry; delete ctx.deviation;
      return ctx;
    }
    throw err;
  }
}

async function compute(ctx) {
  const { document: doc, log } = ctx;
  ctx.legs = {};
  ctx.routeGeometry = {};
  ctx.deviation = {};

  for (const dirName of ["outbound", "return"]) {
    const stops = doc.directions[dirName].orderedStops;
    const coords = stops.map((s) => s.coordinates);
    if (coords.some((c) => c.lat === 0 && c.lng === 0)) {
      throw new Error(`${dirName}: a stop has no coordinates; run stop resolution first`);
    }

    const bands = weekdayBands(doc.estimatedTemporalWindows, dirName);
    const samples = routingSampleIds(bands);
    const baseline = baselineSampleId(bands);

    const launchDate = resolveLaunchDate(doc, ctx.config);
    const routeOpts = { log, launchDate };
    // Base route per traffic sample
    const legs = coords.slice(1).map((_, i) => ({ fromIndex: i, toIndex: i + 1, distanceKm: 0, windows: {} }));
    for (const sampleId of samples) {
      const { hhmm, weekday } = departureForSample(sampleId, doc.estimatedTemporalWindows, dirName);
      const r = await computeRoute(coords, departureIso(hhmm, weekday, doc, ctx.config), routeOpts);
      r.legs.forEach((l, i) => {
        legs[i].distanceKm = l.distanceKm; // identical across samples for the same geometry
        legs[i].windows[sampleId] = { durationMin: l.durationMin, staticDurationMin: l.staticDurationMin };
      });
      if (sampleId === baseline) ctx.routeGeometry[dirName] = { polyline: r.polyline, totalKm: r.totalKm, totalMin: r.totalMin };
      log.info({ direction: dirName, sample: sampleId, km: r.totalKm.toFixed(1), min: Math.round(r.totalMin), cached: r.cached }, "route computed");
    }
    ctx.legs[dirName] = legs;

    // Deviation per intermediate passenger stop: baseline route without it. Intermediate = strictly
    // between the first and last passenger stops (the depot and the terminals are never removed).
    const { hhmm, weekday } = departureForSample(baseline, doc.estimatedTemporalWindows, dirName);
    const departure = departureIso(hhmm, weekday, doc, ctx.config);
    const withStop = ctx.routeGeometry[dirName];
    ctx.deviation[dirName] = {};
    const paxIdx = stops.map((s, i) => (isPassenger(s) ? i : -1)).filter((i) => i >= 0);
    for (const i of paxIdx.slice(1, -1)) {
      const without = coords.filter((_, j) => j !== i);
      const r = await computeRoute(without, departure, routeOpts);
      ctx.deviation[dirName][stops[i].naptanId] = {
        skipIndex: i,
        withoutLegs: r.legs,
        km: withStop.totalKm - r.totalKm,
      };
    }
  }
  return ctx;
}
