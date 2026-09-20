/**
 * Step 5 — SPATIAL RESOLUTION (pipeline step 5).
 *
 * 1. Per passenger stop, request a walk isochrone (ORS; default 10 min, throttled to free-tier rate).
 * 2. Intersect with Census zones (England LSOA + population table; Scotland DZ + totpop2022).
 * 3. Apportion population by area overlap → stop.catchment and ctx.catchments (deduped by naptanId).
 *
 * Depot skipped. Skipped entirely when OpenRouteService is unavailable.
 */

import { isochrone } from "../adapters/openrouteservice.js";
import { zonesIntersecting } from "../adapters/boundaries.js";
import { loadLsoaPopulation } from "../loaders/population.js";
import { proportionalCatchment } from "../domain/catchment.js";
import { CacheMiss } from "../lib/cache.js";
import { sleep } from "../lib/rate-limit.js";
import { DIRECTIONS, isDepot } from "../domain/document.js";

export const name = "spatial";
const ORS_MIN_INTERVAL_MS = 3100; // 20 requests / minute

export async function run(ctx) {
  try {
    return await compute(ctx);
  } catch (err) {
    if (err instanceof CacheMiss || /OPENROUTESERVICE_API_KEY is not set/.test(err.message)) {
      ctx.log.warn({ reason: err.message }, "spatial skipped — OpenRouteService unavailable");
      return ctx;
    }
    throw err;
  }
}

async function compute(ctx) {
  const { document: doc, config, log } = ctx;
  const seconds = config.engine.isochroneWalkSeconds;
  const lsoaPop = await loadLsoaPopulation();
  ctx.catchments = {};
  let lastOrsCall = 0;
  let orsCalls = 0, boundaryZones = 0;

  for (const d of DIRECTIONS) {
    for (const stop of doc.directions[d].orderedStops) {
      if (isDepot(stop)) continue; // no passengers board at the depot: no catchment
      if (ctx.catchments[stop.naptanId]) { stop.catchment = ctx.catchments[stop.naptanId]; continue; }

      // ORS (throttled only when the call is not cached)
      const wait = ORS_MIN_INTERVAL_MS - (Date.now() - lastOrsCall);
      const iso = await isochrone(stop.coordinates, seconds, { log }).catch(async (err) => {
        if (wait > 0 && /429/.test(err.message)) { await sleep(wait); return isochrone(stop.coordinates, seconds, { log }); }
        throw err;
      });
      if (!iso.cached) { orsCalls++; lastOrsCall = Date.now(); await sleep(ORS_MIN_INTERVAL_MS); }

      // Boundaries + population
      const zones = await zonesIntersecting(iso.polygon.geometry, log);
      for (const z of zones) if (z.country === "england-wales") z.population = lsoaPop.get(z.code) ?? null;
      boundaryZones += zones.length;

      const c = proportionalCatchment(iso.polygon, zones);
      if (c.unpopulatedZones.length) log.warn({ stop: stop.stopName, zones: c.unpopulatedZones }, "zones without population");

      stop.catchment = {
        walkSeconds: seconds,
        areaKm2: c.areaKm2,
        population: c.population,
        country: zones[0]?.country ?? "unknown",
        zones: c.zones.map(({ code, name, zonePopulation, ratio, allocated }) => ({ code, name, zonePopulation, ratio, allocated })),
        polygon: iso.polygon.geometry,
      };
      ctx.catchments[stop.naptanId] = stop.catchment;
      log.debug({ stop: stop.stopName, population: c.population, zones: c.zones.length, areaKm2: c.areaKm2 }, "catchment");
    }
  }
  log.info({ stops: Object.keys(ctx.catchments).length, orsCalls, boundaryZones }, "catchments computed");
  return ctx;
}
