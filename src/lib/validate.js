/**
 * Validation of the engine's output against .cursor/DATA_SCHEMA.json (the contract).
 * The schema is compiled once at module load.
 */

import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { config } from "../config.js";

export const schema = JSON.parse(readFileSync(config.paths.schema, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const compiled = ajv.compile(schema);

/**
 * @param {unknown} document
 * @returns {{ valid: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateDocument(document) {
  const valid = compiled(document);
  const errors = valid
    ? []
    : compiled.errors.map((e) => ({
        path: e.instancePath || "/",
        message: e.message ?? "invalid",
        ...(e.params && Object.keys(e.params).length ? { params: e.params } : {}),
      }));
  return { valid, errors };
}

export class SchemaValidationError extends Error {
  constructor(errors) {
    const summary = errors
      .slice(0, 5)
      .map((e) => `${e.path} ${e.message}`)
      .join("; ");
    super(
      `Document failed schema validation (${errors.length} error${errors.length === 1 ? "" : "s"}): ${summary}${errors.length > 5 ? "; …" : ""}`
    );
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

/** Throws SchemaValidationError if invalid; returns the document otherwise. */
export function assertValidDocument(document) {
  const { valid, errors } = validateDocument(document);
  if (!valid) throw new SchemaValidationError(errors);
  return document;
}
