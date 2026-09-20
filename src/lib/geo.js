/**
 * Geographic helpers shared across the engine: coordinate reprojection and distance.
 */

import proj4 from "proj4";

// EPSG:27700 (OSGB 1936 / British National Grid) -> WGS84, 7-parameter Helmert.
// Accuracy ~1–2 m, adequate for catchment analysis. Used for NaPTAN Easting/Northing
// (8% of active bus stops have no Longitude/Latitude) and for boundary shapefiles.
proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
    "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
);

const bngToWgs84 = proj4("EPSG:27700", "EPSG:4326");

/**
 * @param {number} easting
 * @param {number} northing
 * @returns {{ lng: number, lat: number }}
 */
export function bngToLngLat(easting, northing) {
  const [lng, lat] = bngToWgs84.forward([Number(easting), Number(northing)]);
  return { lng: round6(lng), lat: round6(lat) };
}

export const round6 = (n) => Number(n.toFixed(6));

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres between two {lat,lng} points.
 */
export function haversineMetres(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

/**
 * Bounding box [minLng, minLat, maxLng, maxLat] for a set of {lat,lng} points,
 * optionally padded by `padMetres`.
 */
export function bboxOf(points, padMetres = 0) {
  let [minLng, minLat, maxLng, maxLat] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  if (padMetres > 0) {
    const dLat = padMetres / 111_320;
    const dLng = padMetres / (111_320 * Math.cos(toRad((minLat + maxLat) / 2)));
    return [minLng - dLng, minLat - dLat, maxLng + dLng, maxLat + dLat];
  }
  return [minLng, minLat, maxLng, maxLat];
}
