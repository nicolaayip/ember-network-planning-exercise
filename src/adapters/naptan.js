/**
 * NaPTAN adapter: streams the national CSV once, keeps active bus stops in memory,
 * and answers lookups by ATCO code, by name, and by proximity.
 *
 * DESIGN_DOC §2.1. Coordinates fall back to BNG Easting/Northing → WGS84 where
 * Longitude/Latitude are blank (8% of active bus stops).
 */

import { createReadStream } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import { config } from "../config.js";
import { bngToLngLat, haversineMetres } from "../lib/geo.js";

const BUS_STOP_TYPES = new Set(["BCT", "BCS", "BCE"]);
const CELL_DEG = 0.01; // ~1.1 km N–S, ~0.6 km E–W at 55°N

/** @typedef {{ atco: string, name: string, indicator: string, street: string, locality: string, stopType: string, lat: number, lng: number, coordSource: 'wgs84'|'bng' }} Stop */

export class NaptanIndex {
  /** @param {Stop[]} stops */
  constructor(stops) {
    this.byAtco = new Map();
    this.grid = new Map();
    this.stops = stops;
    for (const s of stops) {
      this.byAtco.set(s.atco, s);
      const key = cellKey(s.lat, s.lng);
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(s);
    }
  }

  get size() {
    return this.stops.length;
  }

  /** @returns {Stop|undefined} */
  get(atco) {
    return this.byAtco.get(atco);
  }

  /** Case-insensitive substring search on name / locality / street. */
  search(query, limit = 25) {
    const q = query.toLowerCase();
    const out = [];
    for (const s of this.stops) {
      if (s.name.toLowerCase().includes(q) || s.locality.toLowerCase().includes(q) || s.street.toLowerCase().includes(q)) {
        out.push(s);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * Stops within `radiusM` of a point, nearest first, each annotated with distance.
   * @returns {Array<Stop & { distanceM: number }>}
   */
  near(lat, lng, radiusM = 250) {
    const cells = Math.ceil(radiusM / 600 / CELL_DEG / 100) + 1; // generous neighbourhood
    const [ci, cj] = cellIndex(lat, lng);
    const out = [];
    for (let di = -cells; di <= cells; di++) {
      for (let dj = -cells; dj <= cells; dj++) {
        const bucket = this.grid.get(`${ci + di}:${cj + dj}`);
        if (!bucket) continue;
        for (const s of bucket) {
          const d = haversineMetres({ lat, lng }, s);
          if (d <= radiusM) out.push({ ...s, distanceM: Math.round(d) });
        }
      }
    }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }
}

function cellIndex(lat, lng) {
  return [Math.floor(lat / CELL_DEG), Math.floor(lng / CELL_DEG)];
}
function cellKey(lat, lng) {
  const [i, j] = cellIndex(lat, lng);
  return `${i}:${j}`;
}
/** Initial bearing in degrees from point a to point b. */
export function bearingDeg(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Stream-parse the NaPTAN CSV into a NaptanIndex of active bus stops.
 * @param {{ file?: string, log?: { info: Function } }} [opts]
 */
export async function loadNaptan(opts = {}) {
  const file = opts.file ?? path.join(config.paths.data, "naptan_stops.csv");
  const stops = [];
  let rows = 0, skipped = 0, bng = 0;

  const parser = createReadStream(file).pipe(
    parse({ columns: true, bom: true, relax_quotes: true, relax_column_count: true, trim: true })
  );

  for await (const r of parser) {
    rows++;
    if (r.Status !== "active" || !BUS_STOP_TYPES.has(r.StopType)) { skipped++; continue; }
    let lat = Number(r.Latitude), lng = Number(r.Longitude), coordSource = "wgs84";
    if (!r.Latitude || !r.Longitude || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      if (!r.Easting || !r.Northing) { skipped++; continue; }
      ({ lat, lng } = bngToLngLat(r.Easting, r.Northing));
      coordSource = "bng";
      bng++;
    }
    stops.push({
      atco: r.ATCOCode,
      name: r.CommonName,
      indicator: r.Indicator ?? "",
      street: r.Street ?? "",
      locality: r.LocalityName ?? "",
      stopType: r.StopType,
      lat, lng, coordSource,
    });
  }
  opts.log?.info?.({ rows, kept: stops.length, skipped, bngFallback: bng }, "naptan loaded");
  return new NaptanIndex(stops);
}
