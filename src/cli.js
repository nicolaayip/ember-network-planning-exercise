#!/usr/bin/env node
/**
 * CLI wrapper around runPipeline.
 *
 *   node src/cli.js --input fixtures/routes/edinburgh-glasgow.json [--out output/x.json]
 *   node src/cli.js --name "Edinburgh – Glasgow" --outbound 6200600739,60903717 --return 60903718,6200600740 \
 *                   [--columns 07:00/10:15,09:00/12:15]
 *
 * Writes the document to --out (default: output/<routeId>.json) and, with --stdout,
 * also prints it to stdout. Logs go to stderr.
 */

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runPipeline, config } from "./index.js";
import { writeTables } from "./output/tables.js";

const HELP = `
Usage:
  ember --input <route.json> [--out <file>] [--stdout]
  ember --name <routeName> --outbound <id,id,...> --return <id,id,...>
        [--columns <HH:MM/HH:MM,...>] [--route-id <id>] [--out <file>] [--stdout]

Options:
  -i, --input               Route JSON: { routeId?, routeName, directions: { outbound: { stops }, return: { stops } }, timetableColumns? }
  -n, --name                Route name (inline mode)
      --outbound            Comma-separated ordered ATCO codes for the outbound direction (inline mode)
      --return              Comma-separated ordered ATCO codes for the return direction (inline mode)
      --columns             Timetable columns as outboundDeparture/returnDeparture pairs, e.g. 07:00/10:15,09:00/12:15
                            (omit to run in propose mode)
      --route-id            Override the generated routeId
  -o, --out                 Output file (default: ${path.relative(process.cwd(), config.paths.output)}/<routeId>.json)
      --stdout              Also print the document to stdout
  -h, --help
`.trim();

const splitIds = (s) =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function parseColumns(spec) {
  if (!spec) return undefined;
  return splitIds(spec).map((pair, i) => {
    const [outboundDeparture, returnDeparture] = pair.split("/");
    if (!outboundDeparture || !returnDeparture) {
      throw new Error(`--columns[${i}] must be HH:MM/HH:MM, got "${pair}"`);
    }
    return { outboundDeparture, returnDeparture };
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", short: "i" },
      name: { type: "string", short: "n" },
      outbound: { type: "string" },
      return: { type: "string" },
      columns: { type: "string" },
      "route-id": { type: "string" },
      out: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  let input;
  if (values.input) {
    input = JSON.parse(await readFile(values.input, "utf8"));
  } else if (values.name && values.outbound && values.return) {
    const toStops = (ids) => ids.map((naptanId) => ({ naptanId }));
    input = {
      routeName: values.name,
      directions: {
        outbound: { stops: toStops(splitIds(values.outbound)) },
        return: { stops: toStops(splitIds(values.return)) },
      },
      ...(values.columns ? { timetableColumns: parseColumns(values.columns) } : {}),
    };
  } else {
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  if (values["route-id"]) input.routeId = values["route-id"];

  const document = await runPipeline(input);

  const outPath = values.out ?? path.join(config.paths.output, `${document.routeId}.json`);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(document, null, 2) + "\n");
  console.error(`wrote ${path.relative(process.cwd(), outPath)}`);

  const tables = await writeTables(document, path.dirname(outPath));
  for (const t of tables) console.error(`wrote ${path.relative(process.cwd(), t)}`);

  if (values.stdout) process.stdout.write(JSON.stringify(document, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
});
