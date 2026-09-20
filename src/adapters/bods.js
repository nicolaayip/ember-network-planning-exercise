/**
 * Bus Open Data Service (BODS) timetables adapter (DESIGN_DOC §4.1).
 *
 *   GET {config.endpoints.bods}/dataset/?adminArea=410&limit=100&offset=0&api_key=…   (paginated listing)
 *   GET https://data.bus-data.dft.gov.uk/timetable/dataset/{id}/download/?api_key=…    (zip of TXC files, or a single XML)
 *   GET https://coach.bus-data.dft.gov.uk/TxC-2.4.zip                                   (long-distance coach bulk file, no key)
 *
 * Notes from probing (2026-09-14): the listing lives at `/api/v1/dataset/`, not `/api/v1/timetable/dataset/`;
 * `boundingBox` is not a valid filter (400); `adminArea` and `noc` are. Downloads branch on `content-type`
 * (`application/zip` vs `text/xml`). Listing responses go through the JSON disk cache (key excludes the API
 * key). Dataset files are large and binary, so they are stored under `data/bods/` (gitignored) with a
 * sidecar `<id>.meta.json` recording the BODS `modified` stamp; a file is re-downloaded only when that
 * stamp changes. In MOCK mode nothing is fetched: the listing comes from the cache or, failing that, from
 * the meta files already on disk.
 */

import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { config } from "../config.js";
import { cached, CacheMiss } from "../lib/cache.js";
import { http, withRetry, describeHttpError } from "../lib/http.js";

export const COACH_ZIP_URL = "https://coach.bus-data.dft.gov.uk/TxC-2.4.zip";
const PAGE = 100;

export const bodsDir = () => path.join(config.paths.data, "bods");
const datasetsDir = () => path.join(bodsDir(), "datasets");

const requireKey = () => {
  if (!config.keys.bods) throw new Error("BODS_API_KEY is not set");
  return config.keys.bods;
};

/**
 * All published timetable datasets for one NPTG admin area (e.g. 410 Tyne & Wear). Cached.
 * @returns {Promise<Array<{ id: number, operatorName: string, noc: string[], lines: string[], adminAreas: string[], modified: string, url: string, extension: string, status: string }>>}
 */
export async function listDatasets(adminArea, { log } = {}) {
  const results = [];
  for (let offset = 0; ; offset += PAGE) {
    const params = { adminArea: String(adminArea), limit: PAGE, offset };
    const { value } = await cached("bods", { pathname: "/dataset/", params }, async () => {
      const api_key = requireKey();
      try {
        const res = await withRetry(() => http.get(`${config.endpoints.bods}/dataset/`, { params: { ...params, api_key } }), { log });
        return res.data;
      } catch (err) {
        throw new Error(`BODS /dataset/ adminArea=${adminArea}: ${describeHttpError(err)}`);
      }
    });
    for (const r of value.results ?? []) results.push(normaliseDataset(r));
    if (!value.next || (value.results ?? []).length < PAGE) break;
  }
  return results;
}

function normaliseDataset(r) {
  return {
    id: Number(r.id),
    operatorName: r.operatorName ?? "",
    noc: r.noc ?? [],
    lines: r.lines ?? [],
    adminAreas: (r.adminAreas ?? []).map((a) => String(a.atco_code ?? a)),
    modified: r.modified ?? "",
    url: r.url ?? `https://data.bus-data.dft.gov.uk/timetable/dataset/${r.id}/download/`,
    extension: r.extension ?? "",
    status: r.status ?? "",
    name: r.name ?? "",
  };
}

/**
 * Make sure the dataset file is on disk (download unless present with the same `modified` stamp).
 * @returns {Promise<{ file: string, contentType: string, downloaded: boolean } | null>}  null when MOCK and absent
 */
export async function ensureDatasetFile(ds, { log } = {}) {
  await mkdir(datasetsDir(), { recursive: true });
  const metaFile = path.join(datasetsDir(), `${ds.id}.meta.json`);
  const meta = await readJson(metaFile);
  if (meta?.file && meta.modified === ds.modified && (await exists(path.join(datasetsDir(), meta.file)))) {
    return { file: path.join(datasetsDir(), meta.file), contentType: meta.contentType, downloaded: false };
  }
  if (config.mock) {
    if (meta?.file && (await exists(path.join(datasetsDir(), meta.file)))) return { file: path.join(datasetsDir(), meta.file), contentType: meta.contentType, downloaded: false, stale: true };
    return null;
  }
  const api_key = requireKey();
  let res;
  try {
    res = await withRetry(() => http.get(ds.url, { params: { api_key }, responseType: "arraybuffer", timeout: 180_000, maxContentLength: Infinity }), { log });
  } catch (err) {
    throw new Error(`BODS download ${ds.id}: ${describeHttpError(err)}`);
  }
  const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
  const ext = contentType.includes("zip") ? "zip" : contentType.includes("xml") ? "xml" : ds.extension || "bin";
  const fileName = `${ds.id}.${ext}`;
  await writeFile(path.join(datasetsDir(), fileName), Buffer.from(res.data));
  await writeFile(
    metaFile,
    JSON.stringify({ id: ds.id, file: fileName, contentType, modified: ds.modified, operatorName: ds.operatorName, noc: ds.noc, lines: ds.lines, adminAreas: ds.adminAreas, name: ds.name, downloadedAt: new Date().toISOString(), bytes: res.data.byteLength }, null, 2)
  );
  log?.debug?.({ id: ds.id, bytes: res.data.byteLength, contentType }, "bods dataset downloaded");
  return { file: path.join(datasetsDir(), fileName), contentType, downloaded: true };
}

/** Invoke `fn` once per TransXChange XML (zip, nested zip, or standalone .xml) without retaining all files. */
export async function forEachTxcFile(file, fn) {
  if (file.toLowerCase().endsWith(".xml")) {
    await fn({ name: path.basename(file), xml: await readFile(file, "utf8") });
    return;
  }
  async function walk(zip, prefix) {
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const name = `${prefix}${e.entryName}`;
      if (/\.xml$/i.test(e.entryName)) await fn({ name, xml: e.getData().toString("utf8") });
      else if (/\.zip$/i.test(e.entryName)) await walk(new AdmZip(e.getData()), `${name}/`);
    }
  }
  await walk(new AdmZip(file), "");
}

/** Re-read one TXC entry from an archive path returned by {@link forEachTxcFile}. */
export async function readTxcEntry(archivePath, entryName) {
  if (archivePath.toLowerCase().endsWith(".xml")) return readFile(archivePath, "utf8");
  const xml = findTxcEntry(new AdmZip(archivePath), "", entryName);
  if (!xml) throw new Error(`TXC entry not found: ${entryName}`);
  return xml;
}

function findTxcEntry(zip, prefix, target) {
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = `${prefix}${e.entryName}`;
    if (name === target && /\.xml$/i.test(e.entryName)) return e.getData().toString("utf8");
    if (/\.zip$/i.test(e.entryName)) {
      const xml = findTxcEntry(new AdmZip(e.getData()), `${name}/`, target);
      if (xml) return xml;
    }
  }
  return null;
}

/**
 * Datasets for several admin areas, de-duplicated by id, each with its TXC files loaded.
 * Degrades: listing from cache or on-disk meta files in MOCK mode; per-dataset failures are recorded, not thrown.
 *
 * @returns {Promise<{ listingSource: 'api'|'cache'|'disk'|'none', perArea: Record<string, number>, datasets: Array<{ id, operatorName, noc, lines, adminAreas, modified, file?, error?: string, downloaded?: boolean }> }>}
 */
export async function loadAdminAreas(areas, { log } = {}) {
  const byId = new Map();
  const perArea = {};
  let listingSource = "api";
  for (const area of areas) {
    try {
      const list = await listDatasets(area, { log });
      perArea[area] = list.length;
      for (const d of list) if (!byId.has(d.id)) byId.set(d.id, d);
    } catch (err) {
      if (!(err instanceof CacheMiss) && !/BODS_API_KEY is not set/.test(err.message)) throw err;
      log?.warn?.({ area, reason: err.message }, "bods listing unavailable — using datasets already on disk");
      listingSource = "disk";
      for (const d of await datasetsOnDisk(area)) if (!byId.has(d.id)) byId.set(d.id, d);
      perArea[area] = [...byId.values()].filter((d) => d.adminAreas.includes(String(area))).length;
    }
  }
  if (listingSource === "api" && config.mock) listingSource = "cache";

  const datasets = [];
  for (const ds of byId.values()) {
    const rec = { ...ds };
    try {
      const f = await ensureDatasetFile(ds, { log });
      if (!f) { rec.error = "not on disk (MOCK)"; datasets.push(rec); continue; }
      rec.file = f.file;
      rec.downloaded = f.downloaded;
    } catch (err) {
      rec.error = err.message;
      log?.warn?.({ id: ds.id, operator: ds.operatorName, reason: err.message }, "bods dataset skipped");
    }
    datasets.push(rec);
  }
  return { listingSource: byId.size ? listingSource : "none", perArea, datasets };
}

async function datasetsOnDisk(area) {
  const out = [];
  let names = [];
  try { names = await readdir(datasetsDir()); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith(".meta.json")) continue;
    const m = await readJson(path.join(datasetsDir(), n));
    if (m && (!area || (m.adminAreas ?? []).includes(String(area)))) out.push({ ...normaliseDataset({ ...m, adminAreas: m.adminAreas ?? [] }), url: "" });
  }
  return out;
}

/**
 * The long-distance coach bulk TransXChange zip (§7.8). Downloaded once to data/bods/coach/TxC-2.4.zip.
 * @returns {Promise<{ file: string, downloaded: boolean } | null>}  null when unavailable
 */
export async function loadCoachZip({ log } = {}) {
  const dir = path.join(bodsDir(), "coach");
  const file = path.join(dir, "TxC-2.4.zip");
  let downloaded = false;
  if (!(await exists(file))) {
    if (config.mock) return null;
    await mkdir(dir, { recursive: true });
    try {
      const res = await withRetry(() => http.get(COACH_ZIP_URL, { responseType: "arraybuffer", timeout: 300_000, maxContentLength: Infinity }), { log });
      await writeFile(file, Buffer.from(res.data));
      await writeFile(path.join(dir, "TxC-2.4.meta.json"), JSON.stringify({ url: COACH_ZIP_URL, downloadedAt: new Date().toISOString(), bytes: res.data.byteLength, lastModified: res.headers["last-modified"] ?? null, etag: res.headers.etag ?? null }, null, 2));
      downloaded = true;
    } catch (err) {
      log?.warn?.({ reason: describeHttpError(err) }, "coach bulk zip unavailable");
      return null;
    }
  }
  return { file, downloaded };
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}
async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}
