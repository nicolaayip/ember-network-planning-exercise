/**
 * OpenRouteService isochrones adapter (DESIGN_DOC §3.2).
 *
 * POST /v2/isochrones/foot-walking { locations: [[lng,lat]], range: [seconds], range_type: "time" }
 * -> GeoJSON FeatureCollection with one Polygon per location/range.
 *
 * Free tier: 500 isochrone requests/day, 20/min. Every response is disk-cached by
 * (profile, lng/lat 6 dp, seconds), so a stop is only ever fetched once.
 */

import { config } from "../config.js";
import { cached } from "../lib/cache.js";
import { http, withRetry, describeHttpError } from "../lib/http.js";

/**
 * @param {{ lat: number, lng: number }} point
 * @param {number} seconds  e.g. 600 for a 10-minute walk
 * @param {{ profile?: "foot-walking"|"driving-car", log?: object }} [opts]
 * @returns {Promise<{ polygon: import('geojson').Feature<import('geojson').Polygon>, cached: boolean }>}
 */
export async function isochrone(point, seconds, opts = {}) {
  const profile = opts.profile ?? "foot-walking";
  const url = config.endpoints.openRouteServiceIsochrones.replace(/foot-walking$/, profile);
  const key = { profile, lng: Number(point.lng.toFixed(6)), lat: Number(point.lat.toFixed(6)), seconds };

  const { value, cached: hit } = await cached("openrouteservice", key, async () => {
    if (!config.keys.openRouteService) throw new Error("OPENROUTESERVICE_API_KEY is not set (and no cached response exists)");
    try {
      const res = await withRetry(
        () =>
          http.post(
            url,
            { locations: [[point.lng, point.lat]], range: [seconds], range_type: "time", units: "m" },
            { headers: { Authorization: config.keys.openRouteService, "Content-Type": "application/json", Accept: "application/geo+json" } }
          ),
        { log: opts.log }
      );
      return res.data;
    } catch (err) {
      throw new Error(`OpenRouteService isochrone: ${describeHttpError(err)}`);
    }
  });

  const feature = value.features?.[0];
  if (!feature || feature.geometry?.type !== "Polygon") {
    throw new Error(`OpenRouteService returned no polygon (${JSON.stringify(value).slice(0, 200)})`);
  }
  return { polygon: feature, cached: hit };
}
