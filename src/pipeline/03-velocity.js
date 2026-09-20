/**
 * Step 4 — VELOCITY (DESIGN_DOC §2.3–2.4, flow step 4).
 *
 * Per-leg coach factors from carriageway kind; coach time = static x factor + congestion.
 *
 * @format
 */

import {
  coachFactorForKind,
  coachLegMin,
  sumCoachStaticMin,
} from "../domain/coach-carriageway.js";
import { cumulativeArrivals } from "../domain/leg-interpreter.js";
import {
  isDepot,
  isPassenger,
  layoverStopId,
  legDepartureDwellSeconds,
  schedulingDwellSeconds,
} from "../domain/document.js";
import { parseHHMM } from "../lib/time.js";
import { baselineSampleId, routingSamplesForDirection, weekdayBands } from "../domain/traffic-bands.js";
import { round1, round2, round3 } from "../lib/round.js";

const hhmmDiff = (a, b) => parseHHMM(b) - parseHHMM(a);

export const name = "velocity";

export async function run(ctx) {
  const { document: doc, config, log } = ctx;
  if (!ctx.legs?.outbound) {
    log.warn("no legs from topology; velocity skipped");
    return ctx;
  }
  const factors = config.engine.coachTimeFactor;
  const fallback = factors.central;
  ctx.velocity = {};

  for (const dirName of ["outbound", "return"]) {
    const dir = doc.directions[dirName];
    const stops = dir.orderedStops;
    const legs = ctx.legs[dirName];
    const bands = weekdayBands(doc.estimatedTemporalWindows, dirName);
    const samples = routingSamplesForDirection(doc.estimatedTemporalWindows, dirName);
    const baseline = baselineSampleId(bands);
    const dwellCtx = {
      directionName: dirName,
      layoverStopId: layoverStopId(dir, dirName),
    };
    const dwell = stops.map((s) => schedulingDwellSeconds(s, dwellCtx));
    const centralFactors = legs.map((_, i) =>
      coachFactorForKind(stops[i + 1].carriagewayKind, fallback),
    );

    const arrivals = {};
    for (const sampleId of samples) {
      arrivals[sampleId] = {};
      for (const [fName, f] of Object.entries(factors)) {
        const ratio = f / factors.central;
        const factorsPerLeg = centralFactors.map((cf) => cf * ratio);
        arrivals[sampleId][fName] = cumulativeArrivals(
          legs,
          sampleId,
          factorsPerLeg,
          dwell,
        );
      }
    }

    const byIndex = new Map(stops.map((s, i) => [s.naptanId, i]));
    for (const pair of dir.directionalODPairs) {
      const i = byIndex.get(pair.originStopId),
        j = byIndex.get(pair.destinationStopId);
      const bySample = {};
      for (const sampleId of samples) {
        const a = arrivals[sampleId].central.arrivalOffsetsMin;
        bySample[sampleId] = round1(a[j] - a[i]);
      }
      pair.simulatedTravelTimeMinutes = bySample[baseline];
      pair.simulatedTravelTimeBySample = bySample;
      pair.coachPathKm = round2(legs.slice(i, j).reduce((s, l) => s + l.distanceKm, 0));
      let dwellSec = 0;
      for (let k = i + 1; k < j; k++) dwellSec += dwell[k] ?? 0;
      pair.dwellMinutesBetween = round1(dwellSec / 60);
    }

    const fullCoachStatic = sumCoachStaticMin(legs, centralFactors, baseline);
    const deviation = {};
    for (let i = 1; i < stops.length - 1; i++) {
      const d = ctx.deviation?.[dirName]?.[stops[i].naptanId];
      if (!d || fullCoachStatic == null) continue;
      const shortenedStops = stops.filter((_, j) => j !== d.skipIndex);
      const withoutFactors = d.withoutLegs.map((leg) =>
        coachFactorForKind(shortenedStops[leg.toIndex]?.carriagewayKind, fallback),
      );
      const withoutCoachStatic = sumCoachStaticMin(d.withoutLegs, withoutFactors, baseline);
      if (withoutCoachStatic == null) continue;
      deviation[stops[i].naptanId] = {
        minutes: round1(fullCoachStatic - withoutCoachStatic + dwell[i] / 60),
        km: round1(d.km),
      };
    }

    dir.legs = legs.map((l, i) => {
      const cf = centralFactors[i];
      const coachAdjustedMin = Object.fromEntries(
        Object.entries(factors).map(([k, f]) => [
          k,
          round1(coachLegMin(l.windows[baseline], cf * (f / factors.central))),
        ]),
      );
      const p0 = stops[i].proposedTimes?.[0],
        p1 = stops[i + 1].proposedTimes?.[0];
      const proposedMin = p0 && p1 ? hhmmDiff(p0, p1) : undefined;
      const deadLeg = isDepot(stops[i]) || isDepot(stops[i + 1]);
      const leg = {
        fromStopId: stops[i].naptanId,
        toStopId: stops[i + 1].naptanId,
        ...(deadLeg ? { deadLeg: true } : {}),
        distanceKm: round1(l.distanceKm),
        coachSpeedFactor: round3(cf),
        windows: Object.fromEntries(
          samples.map((sampleId) => [
            sampleId,
            {
              durationMin: round1(l.windows[sampleId].durationMin),
              staticDurationMin: round1(l.windows[sampleId].staticDurationMin),
            },
          ]),
        ),
        coachAdjustedMin,
      };
      const dwellSec = legDepartureDwellSeconds(leg, stops[i], dwellCtx);
      if (proposedMin !== undefined) leg.proposedMin = proposedMin;
      if (proposedMin !== undefined)
        leg.deltaMin = round1(proposedMin - coachAdjustedMin.central - dwellSec / 60);
      return leg;
    });
    const paxIdx = stops.map((s, i) => (isPassenger(s) ? i : -1)).filter((i) => i >= 0);
    const [firstPax, lastPax] = [paxIdx[0], paxIdx.at(-1)];
    dir.endToEndMin = Object.fromEntries(
      samples.map((sampleId) => {
        const a = arrivals[sampleId].central.arrivalOffsetsMin;
        return [sampleId, round1(a[lastPax] - a[firstPax])];
      }),
    );
    if (ctx.routeGeometry?.[dirName]?.polyline)
      dir.routePolyline = ctx.routeGeometry[dirName].polyline;
    for (const s of stops) {
      const d = deviation[s.naptanId];
      if (d) {
        s.deviationMinutes = d.minutes;
        s.deviationKm = d.km;
      }
    }

    ctx.velocity[dirName] = { arrivals };
    log.info(
      {
        direction: dirName,
        endToEndMin: Object.fromEntries(
          samples.map((sampleId) => [sampleId, Math.round(dir.endToEndMin[sampleId])]),
        ),
        carriageway: centralFactors.reduce((acc, f, i) => {
          const k = stops[i + 1].carriagewayKind ?? "fallback";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      },
      "velocity computed",
    );
  }
  return ctx;
}
