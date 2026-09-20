/**
 * ONS Census 2021 TS001 — usual residents by LSOA (England & Wales). data/census2021-ts001-lsoa.csv.
 * Scotland Data Zones carry totpop2022 on the boundary feature itself, so no loader is needed there.
 */

import { createReadStream } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import { config } from "../config.js";

let cache;

/** @returns {Promise<Map<string, number>>} LSOA21CD -> usual residents */
export async function loadLsoaPopulation(file = path.join(config.paths.data, "census2021-ts001-lsoa.csv")) {
  if (cache) return cache;
  const map = new Map();
  const parser = createReadStream(file).pipe(parse({ columns: true, bom: true, trim: true }));
  for await (const r of parser) {
    const code = r["geography code"];
    const total = Number(r["Residence type: Total; measures: Value"]);
    if (code && Number.isFinite(total)) map.set(code, total);
  }
  cache = map;
  return map;
}
