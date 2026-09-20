/**
 * Step 11 — OUTPUT: finalise document. Validation against the schema happens in runPipeline.
 *
 * TODO: spreadsheet tables (§6.1–6.7).
 */
import { buildAssumptionsRegister } from "../domain/assumptions.js";

export const name = "output";

export async function run(ctx) {
  ctx.document.assumptions = buildAssumptionsRegister(ctx.config);
  ctx.document.generatedAt = new Date().toISOString();
  return ctx;
}
