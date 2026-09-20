#!/usr/bin/env node
/**
 * Import assignment route inputs (KMZ + timetable) into one fixture.
 *
 *   node scripts/import-route.js \
 *        --kmz data/task/newcastle_edinburgh_routemap.kmz \
 *        --timetable data/task/newcastle_edinburgh_routetimetable.xlsx \
 *        --route-id newcastle-edinburgh \
 *        [--depot-name "Newcastle Depot"] [--name "Newcastle – Edinburgh (A1)"] \
 *        [--radius 10] [--out fixtures/routes/newcastle-edinburgh.json] [--sheet Timetable]
 */

import { parseArgs } from "node:util";
import { importKmz } from "./lib/import-kmz.js";
import { importTimetable } from "./lib/import-timetable.js";

const { values } = parseArgs({
  options: {
    kmz: { type: "string" },
    timetable: { type: "string" },
    "route-id": { type: "string", default: "newcastle-edinburgh" },
    name: { type: "string", default: "Newcastle – Edinburgh (A1)" },
    "depot-name": { type: "string", default: "Depot" },
    radius: { type: "string", default: "10" },
    out: { type: "string" },
    sheet: { type: "string" },
  },
});

const HELP = `usage: node scripts/import-route.js \\
  --kmz <file.kmz> --timetable <file.xlsx> \\
  [--route-id id] [--name name] [--depot-name name] [--radius m] [--out file] [--sheet name]`;

if (!values.kmz || !values.timetable) {
  console.error(HELP);
  process.exit(1);
}

try {
  const outPath = await importKmz(values.kmz, {
    routeId: values["route-id"],
    name: values.name,
    depotName: values["depot-name"],
    radius: values.radius,
    out: values.out,
  });

  await importTimetable(values.timetable, outPath, { sheet: values.sheet });

  console.error(`\nRoute fixture ready: ${outPath}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
