/**
 * Proportional catchment (DESIGN_DOC §3.2, "the 5% intersection fix"). Pure function.
 *
 * For each candidate zone intersecting the isochrone, the share of the ZONE's area that lies
 * inside the isochrone is applied to the zone's population. A zone 5% inside contributes 5% of
 * its residents.
 */

import * as turf from "@turf/turf";

/**
 * @param {object} isochrone  GeoJSON Feature<Polygon>
 * @param {Array<{ code: string, name: string, country: string, population: number|null, geometry: object }>} zones
 * @returns {{ areaKm2: number, population: number, zones: Array<{ code: string, name: string, country: string, zonePopulation: number|null, ratio: number, allocated: number, intersectKm2: number }>, unpopulatedZones: string[] }}
 */
export function proportionalCatchment(isochrone, zones) {
  const isoArea = turf.area(isochrone);
  const out = [];
  const unpopulated = [];
  for (const z of zones) {
    const feature = turf.feature(z.geometry);
    let inter;
    try {
      inter = turf.intersect(turf.featureCollection([isochrone, feature]));
    } catch {
      inter = null; // degenerate geometry; treat as no overlap
    }
    if (!inter) continue;
    const zoneArea = turf.area(feature);
    const interArea = turf.area(inter);
    if (zoneArea <= 0 || interArea <= 0) continue;
    const ratio = Math.min(1, interArea / zoneArea);
    if (z.population === null || z.population === undefined) unpopulated.push(z.code);
    const allocated = z.population ? z.population * ratio : 0;
    out.push({ code: z.code, name: z.name, country: z.country, zonePopulation: z.population, ratio: round4(ratio), allocated: Math.round(allocated), intersectKm2: round3(interArea / 1e6) });
  }
  out.sort((a, b) => b.allocated - a.allocated);
  return {
    areaKm2: round3(isoArea / 1e6),
    population: out.reduce((s, z) => s + z.allocated, 0),
    zones: out,
    unpopulatedZones: unpopulated,
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10000) / 10000;
