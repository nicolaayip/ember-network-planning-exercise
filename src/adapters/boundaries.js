/**
 * Census boundary polygons intersecting a query polygon, from the live ArcGIS endpoints
 * (DESIGN_DOC §3.2; verified in data/README.md):
 *   - ONS LSOA 2021 BGC FeatureServer (England & Wales) — fields LSOA21CD, LSOA21NM
 *   - Scottish Government Data Zone 2022 MapServer   — fields dzcode, dzname, totpop2022
 *
 * Both are queried for every polygon (each returns nothing outside its country), so cross-border
 * routes need no country detection. Responses are disk-cached.
 */

import { config } from "../config.js";
import { cached } from "../lib/cache.js";
import { http, withRetry, describeHttpError } from "../lib/http.js";

/** @typedef {{ code: string, name: string, country: 'england-wales'|'scotland', population: number|null, geometry: object }} Zone */

function esriPolygon(geometry) {
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  return { rings, spatialReference: { wkid: 4326 } };
}

async function query(layerUrl, geometry, outFields, extra, namespace, log) {
  const params = {
    geometry: JSON.stringify(esriPolygon(geometry)),
    geometryType: "esriGeometryPolygon",
    inSR: 4326,
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    outSR: 4326,
    f: "geojson",
    ...extra,
  };
  const { value } = await cached(namespace, { layerUrl, params }, async () => {
    try {
      const res = await withRetry(() => http.post(`${layerUrl}/query`, new URLSearchParams(params).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } }), { log });
      if (res.data?.error) throw new Error(JSON.stringify(res.data.error));
      return res.data;
    } catch (err) {
      throw new Error(`Boundaries ${namespace}: ${describeHttpError(err)}`);
    }
  });
  return value.features ?? [];
}

/**
 * @param {object} geometry  GeoJSON Polygon/MultiPolygon in WGS84
 * @returns {Promise<Zone[]>}
 */
export async function zonesIntersecting(geometry, log) {
  const [ew, sc] = await Promise.all([
    query(config.endpoints.onsLsoaBoundaries, geometry, "LSOA21CD,LSOA21NM", {}, "boundaries-ons", log),
    // maxAllowableOffset in degrees (~20 m) generalises the full-resolution Scottish geometry server-side
    query(config.endpoints.scotGovDataZoneBoundaries, geometry, "dzcode,dzname,totpop2022", { maxAllowableOffset: 0.0002 }, "boundaries-scotgov", log),
  ]);
  return [
    ...ew.map((f) => ({ code: f.properties.LSOA21CD, name: f.properties.LSOA21NM, country: "england-wales", population: null, geometry: f.geometry })),
    ...sc.map((f) => ({ code: f.properties.dzcode, name: f.properties.dzname, country: "scotland", population: f.properties.totpop2022 ?? null, geometry: f.geometry })),
  ];
}
