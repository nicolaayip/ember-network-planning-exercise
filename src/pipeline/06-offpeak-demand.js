/**
 * Pipeline step 6 — OFF-PEAK DEMAND.
 *
 * 1. Per stop, fetch Overpass POIs in the catchment bbox; filter to the isochrone polygon.
 * 2. Score weekday and weekend POI gravity (distance-decayed weights).
 * 3. Fill each OD pair demandVector: catchment population × destination POI gravity (weekday vs weekend scores).
 *
 * Skipped when catchments are missing; partial scores when Overpass fails.
 *
 * @format
 */

import * as turf from "@turf/turf";
import { poisInBbox } from "../adapters/overpass.js";
import { poiGravity } from "../domain/poi-gravity.js";
import { CacheMiss } from "../lib/cache.js";
import { sleep } from "../lib/rate-limit.js";
import { round1 } from "../lib/round.js";
import { DIRECTIONS, isDepot } from "../domain/document.js";

export const name = "offpeak-demand";
const OVERPASS_MIN_INTERVAL_MS = 1500;

export async function run(ctx) {
  const { document: doc, log } = ctx;
  if (!ctx.catchments || Object.keys(ctx.catchments).length === 0) {
    log.warn("no catchments; off-peak demand skipped");
    return ctx;
  }
  try {
    await scorePois(ctx);
  } catch (err) {
    if (err instanceof CacheMiss || /Overpass/.test(err.message)) {
      log.warn(
        { reason: err.message },
        "POI scoring incomplete — Overpass unavailable; pairs use scores computed so far",
      );
    } else throw err;
  }
  fillPairs(ctx);
  return ctx;
}

async function scorePois(ctx) {
  const { document: doc, log } = ctx;
  ctx.poi = ctx.poi ?? {};
  let calls = 0;
  for (const d of DIRECTIONS) {
    for (const stop of doc.directions[d].orderedStops) {
      if (isDepot(stop)) continue; // not a destination: no POI gravity
      if (ctx.poi[stop.naptanId]) {
        stop.poi = ctx.poi[stop.naptanId];
        continue;
      }
      const c = stop.catchment;
      if (!c?.polygon) continue;
      const iso = turf.feature(c.polygon);
      const bbox = turf.bbox(iso);
      const r = await poisInBbox(bbox, { log });
      if (!r.cached) {
        calls++;
        await sleep(OVERPASS_MIN_INTERVAL_MS);
      }
      const g = poiGravity(stop.coordinates, iso, r.features);
      stop.poi = {
        weekday: g.weekday,
        weekend: g.weekend,
        counts: g.counts,
        features: g.features.slice(0, 25),
      };
      ctx.poi[stop.naptanId] = stop.poi;
      log.debug(
        { stop: stop.stopName, weekday: g.weekday, weekend: g.weekend, counts: g.counts },
        "poi",
      );
    }
  }
  log.info(
    { stops: Object.keys(ctx.poi).length, overpassCalls: calls },
    "poi scores computed",
  );
}

function fillPairs(ctx) {
  const { document: doc, log } = ctx;
  let filled = 0;
  for (const d of DIRECTIONS) {
    const dir = doc.directions[d];
    const byId = new Map(dir.orderedStops.map((s) => [s.naptanId, s]));
    for (const pair of dir.directionalODPairs) {
      const a = byId.get(pair.originStopId),
        b = byId.get(pair.destinationStopId);
      const popA = a.catchment?.population ?? 0;
      const retained = Math.round(popA);
      const poiB = b.poi ?? { weekday: 0, weekend: 0 };
      pair.demandVector.offPeakWeekday = {
        proportionalRetainedPopulation: retained,
        destinationPoiGravityScore: poiB.weekday,
        calculatedWeekdayGravityPotential: round1(retained * poiB.weekday),
      };
      pair.demandVector.offPeakWeekend = {
        proportionalRawResidentPopulation: Math.round(popA),
        destinationPoiWeekendGravityScore: poiB.weekend,
        calculatedWeekendGravityPotential: round1(popA * poiB.weekend),
      };
      filled++;
    }
  }
  log.info({ pairs: filled }, "off-peak demand filled");
}
