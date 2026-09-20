/**
 * Timetable selection (DESIGN_DOC §4.5). Pure functions.
 *
 * A "column" is one driver return trip: outbound departure at the first outbound stop, layover at
 * the far terminal, return departure. Scoring a column = propagate its arrival times through both
 * directions and sum, over every directional pair, the pair's demand weight if the departure at the
 * pair's origin lands inside a Market Opening on that pair.
 *
 * Demand weights are unit-free shares so peak commuters (persons) and off-peak gravity potential
 * (population x POI score) can be combined: each pair's weight in a window = its share of the
 * total demand of that type across all pairs in that direction.
 *
 * Greedy selection: pick the best column, insert its departures into every pair's timeline as a
 * new operator, recompute gaps, repeat. The marginal gain per added column is the
 * services-vs-captured-demand curve.
 *
 * @format
 */

import { parseHHMM } from "../lib/time.js";
import { bandFor, weekdayBands } from "./traffic-bands.js";
import { gapsForTimeline, toSelectionGaps } from "./market-openings.js";
import { DEFAULT_DAY_START_MIN, DEFAULT_DAY_END_MIN } from "./headway.js";

/** Which traffic band a weekday departure (minutes from midnight) falls in. */
export function bandForDeparture(minutes, bands) {
  return bandFor(minutes, bands);
}

/**
 * Demand weight per pair for a day type, as a share of the direction's total.
 * Weekday uses calculatedWeekdayGravityPotential; weekend uses calculatedWeekendGravityPotential.
 * @returns {Map<pairId, weight>}
 */
export function demandWeights(pairs, dayType) {
  const value = (p) => {
    const dv = p.demandVector;
    if (dayType === "weekend")
      return dv.offPeakWeekend?.calculatedWeekendGravityPotential ?? 0;
    if (dayType === "weekday")
      return dv.offPeakWeekday?.calculatedWeekdayGravityPotential ?? 0;
    return 0;
  };
  const total = pairs.reduce((s, p) => s + value(p), 0);
  return new Map(pairs.map((p) => [p.pairId, total > 0 ? value(p) / total : 0]));
}

/**
 * Peak-qualified scoring gaps for a competitor timeline.
 * @returns {Array<{ start: number, end: number, minutes: number, isMarketOpening: boolean, edge?: boolean }>}
 */
export function gapsFromTimeline(
  timestamps,
  thresholdMin,
  dayStart = DEFAULT_DAY_START_MIN,
  dayEnd = DEFAULT_DAY_END_MIN,
  peakBands = [],
) {
  return toSelectionGaps(
    gapsForTimeline(timestamps, peakBands, thresholdMin, dayStart, dayEnd).scoringGaps,
  );
}

/** True if `t` falls strictly inside a market-opening gap. */
export function inMarketOpening(gaps, t) {
  return gaps.some((g) => g.isMarketOpening && t > g.start && t < g.end);
}

/**
 * Capture factor for a departure at `t`: 0 if not inside a market opening, otherwise how excessive
 * the gap is relative to the threshold, (gap − threshold) / gap. Filling an all-day void ≈ 0.9;
 * splitting a 120-min gap at a 90-min threshold = 0.25; gaps at or under the threshold = 0. This
 * gives diminishing returns as our own added services bring headways down to the threshold.
 */
export function captureFactor(gaps, t, thresholdMin) {
  const g = gaps.find((x) => x.isMarketOpening && t > x.start && t < x.end);
  if (!g) return 0;
  return Math.max(0, (g.minutes - thresholdMin) / g.minutes);
}

/**
 * Departure time (minutes) at every stop of a direction for a run leaving stop 0 at `departure`.
 * `arrivalOffsets` = cumulative coach-adjusted minutes incl. dwell (leg-interpreter cumulativeArrivals).
 */
export function stopDepartures(departure, arrivalOffsets) {
  return arrivalOffsets.map((o) => departure + o);
}

/**
 * Build the column: return departure = outbound departure + outbound end-to-end + layover.
 * @param {number} outboundDeparture minutes
 * @param {number} layoverMin
 * @param {{ outbound: Record<window, number[]>, return: Record<window, number[]> }} offsets  arrival offsets per window
 * @param {object} tw temporal windows
 * @param {'weekday'|'weekend'} dayType
 */
export function buildColumn(
  outboundDeparture,
  layoverMin,
  offsets,
  tw,
  dayType = "weekday",
) {
  const outBands = weekdayBands(tw, "outbound");
  const retBands = weekdayBands(tw, "return");
  const wOut =
    dayType === "weekend" ? "weekend" : bandForDeparture(outboundDeparture, outBands);
  const outDep = stopDepartures(outboundDeparture, offsets.outbound[wOut]);
  const outboundArrival = outDep.at(-1);
  const returnDeparture = outboundArrival + layoverMin;
  const wRet =
    dayType === "weekend" ? "weekend" : bandForDeparture(returnDeparture, retBands);
  const retDep = stopDepartures(returnDeparture, offsets.return[wRet]);
  return {
    outboundDeparture,
    outboundArrival,
    layoverMin,
    returnDeparture,
    returnArrival: retDep.at(-1),
    bands: { outbound: wOut, return: wRet },
    departures: { outbound: outDep, return: retDep },
  };
}

/**
 * Score a column against current pair gaps.
 * @param {object} column from buildColumn
 * @param {{ outbound: { pairs, stopIndex: Map<naptanId, number>, gaps: Map<pairId, gaps[]> }, return: {...} }} state
 * @param {'weekday'|'weekend'} dayType
 * @returns {{ score: number, byDirection: { outbound: number, return: number }, hits: Array<{ direction, pairId, t, weight }> }}
 */
export function scoreColumn(column, state, dayType = "weekday") {
  const hits = [];
  const byDirection = { outbound: 0, return: 0 };
  for (const dir of ["outbound", "return"]) {
    const { pairs, stopIndex, gaps, thresholdMin } = state[dir];
    const deps = column.departures[dir];
    const weights = demandWeights(pairs, dayType);
    for (const p of pairs) {
      const i = stopIndex.get(p.originStopId);
      if (i === undefined) continue;
      const t = deps[i];
      const f =
        thresholdMin === undefined
          ? inMarketOpening(gaps.get(p.pairId) ?? [], t)
            ? 1
            : 0
          : captureFactor(gaps.get(p.pairId) ?? [], t, thresholdMin);
      if (f > 0) {
        const w = (weights.get(p.pairId) ?? 0) * f;
        byDirection[dir] += w;
        hits.push({ direction: dir, pairId: p.pairId, t, weight: w, factor: f });
      }
    }
  }
  return { score: byDirection.outbound + byDirection.return, byDirection, hits };
}

/**
 * Insert a column's departures into every pair timeline and recompute gaps.
 * `timelines` : Map<pairId, number[]> per direction (competitor + our previously chosen columns).
 */
export function insertColumn(column, state, thresholdMin) {
  for (const dir of ["outbound", "return"]) {
    const { pairs, stopIndex, timelines, gaps, peakBands, dayStart, dayEnd } = state[dir];
    const th = thresholdMin ?? state[dir].thresholdMin;
    const ds = dayStart ?? DEFAULT_DAY_START_MIN;
    const de = dayEnd ?? DEFAULT_DAY_END_MIN;
    const deps = column.departures[dir];
    for (const p of pairs) {
      const i = stopIndex.get(p.originStopId);
      if (i === undefined) continue;
      const tl = timelines.get(p.pairId) ?? [];
      tl.push(deps[i]);
      timelines.set(p.pairId, tl);
      gaps.set(p.pairId, gapsFromTimeline(tl, th, ds, de, peakBands ?? []));
    }
  }
}

/**
 * Greedy selection of up to `maxColumns` columns.
 * @param {object} p
 * @param {number[]} p.departureGrid  candidate outbound departures (minutes)
 * @param {number[]} p.layovers       candidate layovers (minutes), all ≥ min break
 * @param {object} p.offsets          see buildColumn
 * @param {object} p.state            see scoreColumn (mutated: timelines/gaps updated as columns are added)
 * @param {object} p.tw
 * @param {number} p.thresholdMin
 * @param {number} p.maxColumns
 * @param {number} [p.minMarginalGain=0]  stop when the best remaining column adds less than this share
 * @param {'weekday'|'weekend'} [p.dayType]
 * @returns {{ chosen: Array<column & { score, marginalGain, cumulative }>, curve: Array<{ n, cumulative, marginal }> }}
 */
export function greedySelect(p) {
  const dayType = p.dayType ?? "weekday";
  const chosen = [];
  const curve = [];
  let cumulative = 0;
  let rejectedByAccept = 0;
  for (let n = 1; n <= p.maxColumns; n++) {
    // Rank all candidates by score, then take the best one the acceptor allows (e.g. fits the fleet cap).
    const ranked = [];
    for (const dep of p.departureGrid) {
      for (const lay of p.layovers) {
        // Minimum spacing between our own outbound departures (operational sanity; default one slot)
        const minSpacing = p.minSpacingMin ?? 1;
        if (chosen.some((c) => Math.abs(c.outboundDeparture - dep) < minSpacing))
          continue;
        const col = buildColumn(dep, lay, p.offsets, p.tw, dayType);
        const s = scoreColumn(col, p.state, dayType);
        if (s.score >= (p.minMarginalGain ?? 0)) ranked.push({ col, score: s });
      }
    }
    ranked.sort((a, b) => b.score.score - a.score.score);
    let best = null;
    for (const cand of ranked) {
      if (p.accept && !p.accept(cand.col, chosen)) {
        rejectedByAccept++;
        continue;
      }
      best = cand;
      break;
    }
    if (!best) break;
    insertColumn(best.col, p.state, p.thresholdMin);
    cumulative += best.score.score;
    chosen.push({
      ...best.col,
      score: best.score.score,
      byDirection: best.score.byDirection,
      hits: best.score.hits.length,
      outboundHits: best.score.hits.filter((h) => h.direction === "outbound").length,
      returnHits: best.score.hits.filter((h) => h.direction === "return").length,
      marginalGain: best.score.score,
      cumulative,
    });
    curve.push({ n, cumulative, marginal: best.score.score });
  }
  return { chosen, curve, rejectedByAccept };
}

/**
 * Build the mutable selection state for one direction from the document + competitor gaps.
 * @param {object} direction
 * @param {number} thresholdMin
 * @param {{ peakBands?: object[], dayStart?: number, dayEnd?: number, gapField?: string }} [opts]
 */
export function directionState(direction, thresholdMin, opts = {}) {
  const {
    peakBands = [],
    dayStart = DEFAULT_DAY_START_MIN,
    dayEnd = DEFAULT_DAY_END_MIN,
    gapField = "calculatedHeadwayGaps",
  } = opts;
  const stopIndex = new Map(direction.orderedStops.map((s, i) => [s.naptanId, i]));
  const timelines = new Map();
  const gaps = new Map();
  for (const p of direction.directionalODPairs) {
    const stored =
      p.supplyVector?.[gapField] ?? p.supplyVector?.calculatedHeadwayGaps ?? [];
    const scoring = stored
      .filter((g) => g.isMarketOpening)
      .map((g) => ({
        start: parseHHMM(g.gapStart),
        end: parseHHMM(g.gapEnd),
        minutes: g.durationMinutes,
        isMarketOpening: true,
      }));
    const ts = new Set(
      (p.supplyVector?.competitorDepartures ?? [])
        .map((d) => parseHHMM(d.time))
        .filter((t) => t != null),
    );
    timelines.set(p.pairId, [...ts]);
    gaps.set(
      p.pairId,
      scoring.length
        ? scoring
        : gapsFromTimeline([], thresholdMin, dayStart, dayEnd, peakBands),
    );
  }
  return {
    pairs: direction.directionalODPairs,
    stopIndex,
    timelines,
    gaps,
    thresholdMin,
    peakBands,
    dayStart,
    dayEnd,
  };
}
