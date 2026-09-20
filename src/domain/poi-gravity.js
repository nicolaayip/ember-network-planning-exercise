/**
 * POI gravity score (DESIGN_DOC §3.5). Pure functions.
 *
 * score(dayType) = Σ over features inside the isochrone of weight[group][dayType] x decay(distance)
 * decay = 1.0 within 0–400 m of the stop, 0.5 for 401–800 m, 0 beyond.
 *
 * @format
 */

import * as turf from "@turf/turf";
import { haversineMetres } from "../lib/geo.js";

/** Weights from the §3.5 table. */
export const POI_WEIGHTS = {
  medical: { weekday: 10, weekend: 2 },
  retail: { weekday: 7, weekend: 8 },
  education: { weekday: 7, weekend: 1 },
  leisure: { weekday: 2, weekend: 10 },
};

export function distanceDecay(metres) {
  if (metres <= 400) return 1.0;
  if (metres <= 800) return 0.5;
  return 0;
}

/**
 * @param {{ lat: number, lng: number }} stop
 * @param {object} isochrone  GeoJSON Feature<Polygon>
 * @param {Array<{ id: string, group: string, name: string, lat: number, lng: number }>} features
 * @param {typeof POI_WEIGHTS} [weights]
 */
export function poiGravity(stop, isochrone, features, weights = POI_WEIGHTS) {
  const kept = [];
  const counts = Object.fromEntries(Object.keys(weights).map((g) => [g, 0]));
  let weekday = 0,
    weekend = 0;
  const seen = new Set();
  for (const f of features) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    if (!turf.booleanPointInPolygon(turf.point([f.lng, f.lat]), isochrone)) continue;
    const d = haversineMetres(stop, f);
    const decay = distanceDecay(d);
    if (decay === 0) continue;
    const w = weights[f.group];
    if (!w) continue;
    counts[f.group]++;
    weekday += w.weekday * decay;
    weekend += w.weekend * decay;
    kept.push({
      id: f.id,
      name: f.name,
      group: f.group,
      distanceM: Math.round(d),
      decay,
      weekday: w.weekday * decay,
      weekend: w.weekend * decay,
    });
  }
  kept.sort((a, b) => b.weekday + b.weekend - (a.weekday + a.weekend));
  return { weekday: round1(weekday), weekend: round1(weekend), counts, features: kept };
}

const round1 = (n) => Math.round(n * 10) / 10;
