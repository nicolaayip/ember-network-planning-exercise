/**
 * Shared axios instance with retry/backoff on 429 / 5xx / network errors, honouring Retry-After.
 */

import axios from "axios";

// A descriptive User-Agent is required by some public APIs (overpass-api.de returns 406 to the
// default axios UA) and is polite to all of them.
export const USER_AGENT = "ember-route-engine/0.1 (+https://github.com/ ; network-planning exercise)";
export const http = axios.create({ timeout: 60_000, headers: { "User-Agent": USER_AGENT } });

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {() => Promise<import('axios').AxiosResponse>} fn
 * @param {{ attempts?: number, baseMs?: number, log?: { warn: Function } }} [opts]
 */
export async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 800;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retryable = !err.response || RETRY_STATUS.has(status);
      if (!retryable || i === attempts - 1) throw err;
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseMs * 2 ** i + Math.random() * 250;
      opts.log?.warn?.({ status, attempt: i + 1, delayMs: Math.round(delay) }, "http retry");
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Compact error text for logs. */
export function describeHttpError(err) {
  if (err.response) {
    const body = err.response.data;
    const msg = body?.error?.message ?? (typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200));
    return `HTTP ${err.response.status}: ${msg}`;
  }
  return err.message;
}
