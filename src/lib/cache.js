/**
 * Disk cache for adapter responses. Key -> JSON file under cache/<namespace>/<sha1>.json.
 * In MOCK mode reads are allowed but a miss throws, so no network call can happen.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export class CacheMiss extends Error {
  constructor(namespace, key) {
    super(`MOCK=true and no cached response for ${namespace}: ${key.slice(0, 120)}`);
    this.name = "CacheMiss";
  }
}

const fileFor = (namespace, key) =>
  path.join(config.paths.cache, namespace, `${createHash("sha1").update(key).digest("hex")}.json`);

/**
 * @template T
 * @param {string} namespace  e.g. "google-routes"
 * @param {string|object} keyInput  stable description of the request
 * @param {() => Promise<T>} fetcher  invoked on a miss (never in MOCK mode)
 * @returns {Promise<{ value: T, cached: boolean }>}
 */
export async function cached(namespace, keyInput, fetcher) {
  const key = typeof keyInput === "string" ? keyInput : JSON.stringify(keyInput);
  const file = fileFor(namespace, key);
  try {
    const raw = await readFile(file, "utf8");
    return { value: JSON.parse(raw).value, cached: true };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (config.mock) throw new CacheMiss(namespace, key);
  const value = await fetcher();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ key, storedAt: new Date().toISOString(), value }, null, 2));
  return { value, cached: false };
}
