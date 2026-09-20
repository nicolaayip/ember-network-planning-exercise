/**
 * Path detour for one OD pair (DESIGN_DOC §2.3).
 *
 * Coach path = road km along the service stop sequence (sum of topology legs).
 * Direct car = Google DRIVE A→B with no intermediates (Route Matrix, off-peak).
 *
 *   pathDetourRatio = coachPathKm / directCarKm   (> 1 → coach path longer than driving direct)
 */

import config from "../config.js";

/** Flag pairs where the coach path is materially longer than driving direct. */
export const PATH_DETOUR_WARN = config.engine.pathDetourWarnRatio;

/**
 * @param {{ coachPathKm?: number, directCarKm?: number }} p
 * @returns {{ coachPathKm: number, directCarKm: number, pathDetourRatio: number, pathDetourWarning: boolean } | null}
 */
export function pathDetour({ coachPathKm, directCarKm }) {
  const coach = Number(coachPathKm);
  const direct = Number(directCarKm);
  if (!Number.isFinite(coach) || !Number.isFinite(direct) || direct <= 0) return null;
  const pathDetourRatio = Math.round((coach / direct) * 1000) / 1000;
  return {
    coachPathKm: Math.round(coach * 100) / 100,
    directCarKm: Math.round(direct * 100) / 100,
    pathDetourRatio,
    pathDetourWarning: pathDetourRatio > PATH_DETOUR_WARN,
  };
}
