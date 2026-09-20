#!/usr/bin/env node
/**
 * Copy engine outputs into web/public/scenarios/ and write the index the dashboard reads.
 *
 *   node scripts/sync-scenarios.mjs                 # every ../output/*.json
 *   node scripts/sync-scenarios.mjs --label newcastle-edinburgh="Proposed timetable"
 *   node scripts/sync-scenarios.mjs --pins newcastle-edinburgh=../data/task/newcastle_edinburgh_routemap.kmz
 *
 * Labels default to routeName (+ mode). The dashboard is static: this is the only "API".
 *
 * Reference pins: any .kmz under ../data/task/ is parsed into public/reference/<file>.pins.json
 * (Google My Maps layers → { layer, name, lat, lng }). A scenario gets the pins file whose name
 * shares a token with its routeId unless overridden with --pins. The map draws them beside the
 * NaPTAN stops the importer chose, so the snap can be checked visually.
 */

import AdmZip from "adm-zip";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, "../../output");
const taskDir = path.resolve(here, "../../data/task");
const publicDir = path.resolve(here, "../public");
const scenarioDir = path.join(publicDir, "scenarios");
const referenceDir = path.join(publicDir, "reference");

const labels = {}, pinsOverride = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^([^=]+)=(.*)$/.exec(argv[i + 1] ?? "");
  if (argv[i] === "--label" && m) { labels[m[1]] = m[2]; i++; }
  if (argv[i] === "--pins" && m) { pinsOverride[m[1]] = m[2]; i++; }
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

/** Parse a Google My Maps KMZ into pins: one per Point placemark, tagged with its layer (Folder). */
function parseKmz(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find((e) => /\.kml$/i.test(e.entryName));
  if (!entry) return [];
  const kml = entry.getData().toString("utf8");
  const pins = [];
  const folders = [...kml.matchAll(/<Folder>([\s\S]*?)<\/Folder>/g)];
  const scopes = folders.length ? folders.map((f) => f[1]) : [kml];
  for (const scope of scopes) {
    const layer = decode(/<name>([^<]*)<\/name>/.exec(scope)?.[1] ?? "");
    let seq = 0;
    for (const pm of scope.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
      const name = decode(/<name>([^<]*)<\/name>/.exec(pm[1])?.[1] ?? "");
      const c = /<Point>[\s\S]*?<coordinates>\s*([-\d.]+),([-\d.]+)/.exec(pm[1]);
      if (c) pins.push({ layer, seq: seq++, name, lng: Number(c[1]), lat: Number(c[2]) });
    }
  }
  return pins;
}

await mkdir(scenarioDir, { recursive: true });
await mkdir(referenceDir, { recursive: true });

// Reference pins from every KMZ in data/task
const pinFiles = {};
let kmzFiles = [];
try { kmzFiles = (await readdir(taskDir)).filter((f) => /\.kmz$/i.test(f)); } catch { /* no task dir */ }
for (const f of kmzFiles) {
  const pins = parseKmz(await readFile(path.join(taskDir, f)));
  const out = `${path.basename(f, path.extname(f))}.pins.json`;
  await writeFile(path.join(referenceDir, out), JSON.stringify({ source: `data/task/${f}`, pins }, null, 1));
  pinFiles[f] = `reference/${out}`;
  console.log(`parsed ${pins.length} pins from ${f}`);
}
const pinsFor = (routeId) => {
  if (pinsOverride[routeId]) return `reference/${path.basename(pinsOverride[routeId], ".kmz")}.pins.json`;
  const tokens = routeId.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
  const hit = Object.keys(pinFiles).find((f) => tokens.some((t) => f.toLowerCase().includes(t)));
  return hit ? pinFiles[hit] : undefined;
};
for (const [routeId, kmz] of Object.entries(pinsOverride)) {
  const pins = parseKmz(await readFile(path.resolve(process.cwd(), kmz)));
  const out = `${path.basename(kmz, ".kmz")}.pins.json`;
  await writeFile(path.join(referenceDir, out), JSON.stringify({ source: kmz, pins }, null, 1));
  console.log(`parsed ${pins.length} pins from ${kmz} for ${routeId}`);
}

// Scenarios
const files = (await readdir(outputDir)).filter((f) => f.endsWith(".json")).sort();
const index = [];
for (const file of files) {
  const doc = JSON.parse(await readFile(path.join(outputDir, file), "utf8"));
  const id = path.basename(file, ".json");
  await copyFile(path.join(outputDir, file), path.join(scenarioDir, file));
  index.push({
    id,
    label: labels[id] ?? `${doc.routeName ?? id}${doc.mode ? ` — ${doc.mode}` : ""}`,
    file: `scenarios/${file}`,
    pins: pinsFor(doc.routeId ?? id),
    description: doc.daysOfOperation ? `${doc.daysOfOperation}; ${doc.timetableColumns?.length ?? 0} columns` : undefined,
  });
}
await writeFile(path.join(scenarioDir, "index.json"), JSON.stringify(index, null, 2));
console.log(`synced ${index.length} scenario(s) → ${path.relative(process.cwd(), scenarioDir)}`);
