/**
 * OpenStreetMap Overpass adapter (DESIGN_DOC §3.5).
 *
 * One query per stop covering all four tag groups within the isochrone's bounding box; results
 * carry a representative point (`center` for ways/relations). Filtering to the isochrone polygon
 * and distance decay happen locally in domain/poi-gravity.js. Disk-cached; the public instance is
 * rate-limited, so uncached calls are spaced by the caller.
 */

import { config } from "../config.js";
import { cached } from "../lib/cache.js";
import { http, withRetry, describeHttpError } from "../lib/http.js";

/** Tag groups from DESIGN_DOC §3.5. Order matters for classification (first match wins). */
export const TAG_GROUPS = [
  { group: "medical", match: (t) => t.amenity === "hospital" || t.amenity === "clinic" },
  { group: "retail", match: (t) => t.shop === "supermarket" || t.shop === "mall" },
  { group: "education", match: (t) => t.amenity === "university" || t.amenity === "college" },
  { group: "leisure", match: (t) => t.tourism === "attraction" || t.leisure === "park" || t.amenity === "bus_station" },
];

export function classify(tags = {}) {
  return TAG_GROUPS.find((g) => g.match(tags))?.group ?? null;
}

const buildQuery = ([w, s, e, n]) => {
  const bbox = `${s},${w},${n},${e}`;
  return `[out:json][timeout:60];
(
  nwr["amenity"~"^(hospital|clinic|university|college|bus_station)$"](${bbox});
  nwr["shop"~"^(supermarket|mall)$"](${bbox});
  nwr["tourism"="attraction"](${bbox});
  nwr["leisure"="park"](${bbox});
);
out center tags;`;
};

async function fetchOverpass(query, key, opts = {}) {
  const { value, cached: hit } = await cached("overpass", key, async () => {
    const body = new URLSearchParams({ data: query }).toString();
    const mirrors = config.endpoints.overpassMirrors?.length ? config.endpoints.overpassMirrors : [config.endpoints.overpass];
    let lastErr;
    for (const url of mirrors) {
      try {
        const res = await withRetry(
          () => http.post(url, body, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 35_000 }),
          { log: opts.log, attempts: 2, baseMs: 2000 }
        );
        if (res.data?.remark && /runtime error|timed out/i.test(res.data.remark)) throw Object.assign(new Error(res.data.remark), { response: { status: 504 } });
        return res.data;
      } catch (err) {
        lastErr = err;
        opts.log?.warn?.({ mirror: url, error: describeHttpError(err) }, "overpass mirror failed; trying next");
      }
    }
    throw new Error(`Overpass: all mirrors failed — ${describeHttpError(lastErr)}`);
  });
  return { data: value, cached: hit };
}

/**
 * @param {[number, number, number, number]} bbox  [minLng, minLat, maxLng, maxLat]
 * @returns {Promise<{ features: Array<{ id: string, group: string, name: string, lat: number, lng: number, tags: object }>, cached: boolean }>}
 */
export async function poisInBbox(bbox, opts = {}) {
  const key = { bbox: bbox.map((x) => Number(x.toFixed(5))), v: 1 };
  const { data, cached: hit } = await fetchOverpass(buildQuery(bbox), key, opts);
  const features = [];
  for (const el of data.elements ?? []) {
    const group = classify(el.tags);
    if (!group) continue;
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    features.push({ id: `${el.type}/${el.id}`, group, name: el.tags?.name ?? "(unnamed)", lat, lng, tags: el.tags ?? {} });
  }
  return { features, cached: hit };
}

/**
 * Highway ways within `radiusM` of a path (lat/lng pairs).
 * @param {Array<{ lat: number, lng: number }>} points
 */
export async function waysAlongPath(points, radiusM = 120, opts = {}) {
  if (points.length < 2) return { elements: [], cached: true };
  const coords = points.flatMap((p) => [p.lat, p.lng]).map((x) => Number(x.toFixed(6))).join(",");
  const query = `[out:json][timeout:60];
way["highway"~"^(motorway|trunk|motorway_link|trunk_link)$"](around:${radiusM},${coords});
out body tags;`;
  const key = { waysAlongPath: coords, radiusM, v: 1 };
  const { data, cached: hit } = await fetchOverpass(query, key, opts);
  return { elements: data.elements ?? [], cached: hit };
}
