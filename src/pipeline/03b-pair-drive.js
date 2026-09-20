/**
 * Step 4b — PAIR PATH (pipeline step 4b).
 *
 * 1. Call Google Route Matrix once per direction (off-peak baseline departure).
 * 2. Write directCarKm and drive minutes on each OD pair.
 * 3. Set pathDetourRatio = coachPathKm / directCarKm (coach path from velocity).
 *
 * Skipped when velocity did not run or Google Route Matrix is unavailable.
 */

import { computeRouteMatrix, departureForSample, departureIso, resolveLaunchDate } from "../adapters/google-routes.js";
import { baselineSampleId, weekdayBands } from "../domain/traffic-bands.js";
import { passengerStops } from "../domain/document.js";
import { pathDetour } from "../domain/pair-competitiveness.js";
import { CacheMiss } from "../lib/cache.js";

export const name = "pair-drive";

export async function run(ctx) {
  const { document: doc, config, log } = ctx;
  if (!ctx.velocity) {
    log.warn("velocity did not run; pair path metrics skipped");
    return ctx;
  }

  const tw = doc.estimatedTemporalWindows;

  let pairs = 0, matrixCalls = 0, cachedHits = 0, elements = 0, highDetour = 0;

  for (const dirName of ["outbound", "return"]) {
    const baseline = baselineSampleId(weekdayBands(tw, dirName));
    const { hhmm, weekday } = departureForSample(baseline, tw, dirName);
    const launchDate = resolveLaunchDate(doc, config);
    const departure = departureIso(hhmm, weekday, doc, config);
    const dir = doc.directions[dirName];
    const pax = passengerStops(dir);
    const coords = pax.map((s) => s.coordinates);
    const paxIndex = new Map(pax.map((s, i) => [s.naptanId, i]));

    let matrix;
    try {
      matrix = await computeRouteMatrix(coords, coords, departure, { log, launchDate });
      matrixCalls++;
      if (matrix.cached) cachedHits++;
    } catch (err) {
      if (err instanceof CacheMiss || /GOOGLE_MAPS_API_KEY is not set/.test(err.message)) {
        log.warn({ reason: err.message }, "pair path metrics skipped — Google Route Matrix unavailable");
        return ctx;
      }
      throw err;
    }

    const byCell = new Map(
      matrix.elements.map((e) => [`${e.originIndex}:${e.destinationIndex}`, e])
    );
    elements += matrix.elements.length;

    for (const pair of dir.directionalODPairs) {
      const o = paxIndex.get(pair.originStopId);
      const d = paxIndex.get(pair.destinationStopId);
      if (o === undefined || d === undefined || o >= d) continue;

      const cell = byCell.get(`${o}:${d}`);
      if (!cell) continue;

      pair.directCarKm = cell.distanceKm;
      pair.directCarDriveMinutes = cell.durationMin;
      pair.directCarStaticDriveMinutes = cell.staticDurationMin;
      const detour = pathDetour({ coachPathKm: pair.coachPathKm, directCarKm: cell.distanceKm });
      if (detour) {
        pair.pathDetourRatio = detour.pathDetourRatio;
        pair.pathDetourWarning = detour.pathDetourWarning;
        if (detour.pathDetourWarning) highDetour++;
      }
      pairs++;
    }
  }

  log.info({ pairs, matrixCalls, cachedHits, matrixElements: elements, highDetour }, "pair path metrics");
  return ctx;
}
