/**
 * Engine entry point. `runPipeline` takes a route definition and returns a document
 * that satisfies .cursor/DATA_SCHEMA.json. No HTTP, no CLI concerns live here.
 *
 * @typedef {object} StopInput
 * @property {string} naptanId
 * @property {boolean} [isSingleCarriageway]  leg ARRIVING at this stop is single carriageway
 * @property {boolean} [alwaysServed]
 * @property {number} [dwellTimeBufferSeconds]
 * @property {string} [stopName]
 * @property {string} [localityName]
 * @property {{ lat: number, lng: number }} [coordinates]
 *
 * @typedef {object} RouteInput
 * @property {string} [routeId]
 * @property {string} routeName
 * @property {{ outbound: { label?: string, stops: StopInput[] }, return: { label?: string, stops: StopInput[] } }} directions
 * @property {Array<{ columnId?: string, outboundDeparture: string, returnDeparture: string }>} [timetableColumns]
 *           supplied -> evaluate mode; omitted -> propose mode (DESIGN_DOC §2.1, §4.5)
 */

import { config } from "./config.js";
import { createLogger } from "./lib/log.js";
import { assertValidDocument } from "./lib/validate.js";
import { buildEmptyDocument } from "./domain/document.js";
import { steps } from "./pipeline/index.js";

/**
 * @param {RouteInput} input
 * @param {{ log?: ReturnType<typeof createLogger>, onProgress?: (e: {step: string, index: number, total: number, ms: number}) => void }} [options]
 */
export async function runPipeline(input, options = {}) {
  const log = options.log ?? createLogger(config.logLevel);
  const document = buildEmptyDocument(input, config.engine);

  const ctx = {
    input,
    config,
    log: log.child({ routeId: document.routeId }),
    document,
    // Scratch space shared between steps; not part of the output document.
    legs: [],
    catchments: {},
  };

  ctx.log.info(
    {
      mode: document.mode,
      stops: {
        outbound: document.directions.outbound.orderedStops.length,
        return: document.directions.return.orderedStops.length,
      },
      pairs:
        document.directions.outbound.directionalODPairs.length +
        document.directions.return.directionalODPairs.length,
      columns: document.timetableColumns.length,
      mock: config.mock,
    },
    "pipeline start"
  );

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const t0 = performance.now();
    await step.run(ctx);
    const ms = Math.round(performance.now() - t0);
    ctx.log.info({ step: step.name, ms }, "step complete");
    options.onProgress?.({ step: step.name, index: i, total: steps.length, ms });
  }

  assertValidDocument(ctx.document);
  ctx.log.info("pipeline complete — document valid");
  return ctx.document;
}

export { buildEmptyDocument } from "./domain/document.js";
export { validateDocument, assertValidDocument, SchemaValidationError } from "./lib/validate.js";
export { config } from "./config.js";
