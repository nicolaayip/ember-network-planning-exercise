/**
 * Pipeline step 10 — OUTPUT.
 *
 * 1. Build the assumptions register from config.
 * 2. Stamp generatedAt on the document.
 *
 * Schema validation runs in runPipeline; CSV tables are written by src/output/tables.js (cli).
 *
 * @format
 */

import { buildAssumptionsRegister } from "../domain/assumptions.js";

export const name = "output";

export async function run(ctx) {
  ctx.document.assumptions = buildAssumptionsRegister(ctx.config);
  ctx.document.generatedAt = new Date().toISOString();
  return ctx;
}
