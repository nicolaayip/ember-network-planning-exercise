/**
 * Step 3c — CARRIAGEWAY (pipeline step 3c).
 *
 * 1. Walk each leg along the Google route polyline (subsampled for Overpass).
 * 2. Query OSM ways on the path; tag each destination stop urban / single / dual.
 *
 * Skipped when route geometry is missing.
 */

import { waysAlongPath } from "../adapters/overpass.js";
import { dominantKind } from "../domain/coach-carriageway.js";
import { decodePolyline } from "../lib/polyline.js";

export const name = "carriageway";

const nearestVertex = (coords, p) => {
  let best = 0;
  let bestD = Infinity;
  coords.forEach(([lng, lat], i) => {
    const d = (lat - p.lat) ** 2 + (lng - p.lng) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
};

const subsample = (coords, max = 40) => {
  if (coords.length <= max) return coords.map(([lng, lat]) => ({ lat, lng }));
  const step = Math.ceil(coords.length / max);
  const out = coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
  return out.map(([lng, lat]) => ({ lat, lng }));
};

export async function run(ctx) {
  const { document: doc, log } = ctx;
  if (!ctx.routeGeometry?.outbound?.polyline) {
    log.warn("carriageway skipped — no route geometry");
    return ctx;
  }

  for (const dirName of ["outbound", "return"]) {
    const polyline = ctx.routeGeometry[dirName]?.polyline;
    const stops = doc.directions[dirName]?.orderedStops;
    if (!polyline || !stops?.length) continue;

    const coords = decodePolyline(polyline);
    const counts = { urban: 0, single: 0, dual: 0 };

    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i].coordinates;
      const to = stops[i + 1].coordinates;
      const a = nearestVertex(coords, from);
      const b = nearestVertex(coords, to);
      const slice = coords.slice(Math.min(a, b), Math.max(a, b) + 1);
      const { elements } = await waysAlongPath(subsample(slice), 120, { log });
      const kind = dominantKind(elements);
      stops[i + 1].carriagewayKind = kind;
      counts[kind] += 1;
    }

    log.info({ direction: dirName, legs: counts }, "carriageway tagged");
  }
  return ctx;
}
