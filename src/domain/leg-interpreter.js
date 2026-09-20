/**
 * Leg interpreter (DESIGN_DOC §2.3–2.4). Pure functions.
 *
 * coachAdjusted = static x factor + max(0, duration − static); dwell at passenger departures.
 *
 * @format
 */

import { coachLegMin } from "./coach-carriageway.js";

/**
 * Cumulative arrival offset (minutes from departure at stop 0) at each stop, for one window.
 *
 * @param {Array<{ windows: Record<string, { durationMin: number, staticDurationMin: number }> }>} legs
 * @param {string} window
 * @param {number[]} factorsPerLeg
 * @param {number[]} dwellSecondsPerStop
 */
export function cumulativeArrivals(legs, window, factorsPerLeg, dwellSecondsPerStop) {
  const arrivals = [0];
  const legMinutes = [];
  let t = 0;
  for (let i = 0; i < legs.length; i++) {
    const adjusted = coachLegMin(legs[i].windows[window], factorsPerLeg[i]) ?? 0;
    legMinutes.push(adjusted);
    if (i > 0) t += (dwellSecondsPerStop[i] ?? 0) / 60;
    t += adjusted;
    arrivals.push(t);
  }
  return { arrivalOffsetsMin: arrivals, legMinutes };
}

/** Arrival-to-arrival travel between ordered pairs (i<j). */
export function pairTravelMinutes(arrivalOffsetsMin) {
  const out = new Map();
  for (let i = 0; i < arrivalOffsetsMin.length; i++) {
    for (let j = i + 1; j < arrivalOffsetsMin.length; j++) {
      out.set(`${i}->${j}`, arrivalOffsetsMin[j] - arrivalOffsetsMin[i]);
    }
  }
  return out;
}
