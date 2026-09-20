/**
 * Step 9 — TIMETABLE SELECTION (DESIGN_DOC §4.5, flow step 9).
 *
 * Evaluate: score every supplied column (as timetabled — the departure times passengers would see)
 * against competitor market openings, standalone and incrementally in column order.
 * Propose: greedy selection of columns (outbound departure x layover) using modelled running times,
 * for weekday and Saturday; produces the services-vs-captured-demand curve.
 *
 * Demand weights are unit-free shares (domain/timetable-selection.js). Greedy discovery is
 * uncapped; fleet fit (§4.5 step 2) trims the discovered set separately in domain/fleet-fit.js.
 *
 * @format
 */

import { parseHHMM, formatHHMM } from "../lib/time.js";
import { DIRECTIONS, passengerStops } from "../domain/document.js";
import {
  gapsFromTimeline,
  buildColumn,
  scoreColumn,
  insertColumn,
  greedySelect,
  bandForDeparture,
} from "../domain/timetable-selection.js";
import { rankStandaloneSlots, selectSlotsByGapHits } from "../domain/slot-ranking.js";
import { fitFleetCap } from "../domain/fleet-fit.js";
import { peakBandsForDirection } from "../domain/market-openings.js";
import { DEFAULT_DAY_START_MIN, DEFAULT_DAY_END_MIN } from "../domain/headway.js";
import { routingSamplesForDirection, weekdayBands } from "../domain/traffic-bands.js";
import { competitorDeparturesMinutes } from "../domain/supply-vector.js";
import { deadLegAllowances, fleetScheduleContext } from "../domain/fleet-energy.js";
import { round4 } from "../lib/round.js";

export const name = "selection";

export async function run(ctx) {
  const { document: doc, config, log } = ctx;
  const threshold = config.engine.headwayGapThresholdMinutes;
  const sel = config.selection;
  const tw = doc.estimatedTemporalWindows;

  const offsets = arrivalOffsets(ctx);
  if (!offsets) {
    log.warn("no running times (velocity or proposed timetable); selection skipped");
    return ctx;
  }

  const result = {
    thresholdMinutes: threshold,
    candidateGrid: {
      from: formatHHMM(sel.gridStartMin),
      to: formatHHMM(sel.gridEndMin),
      stepMin: sel.gridStepMin,
      layoversMin: sel.layoversMin,
    },
    weekday: {},
    weekend: {},
  };

  // ---- Evaluate the supplied columns (weekday + weekend competitor timelines) -------------------
  if (doc.timetableColumns.length) {
    const evaluateProposal = (supplyDay, scoreDayType) => {
      const base = buildState(ctx, supplyDay, threshold, scoreDayType);
      const state = cloneSelectionState(base);
      const fresh = cloneSelectionState(base);
      let cumulative = 0;
      const columns = doc.timetableColumns.map((col, c) => {
        const column = proposalColumn(doc, col, c, tw, scoreDayType);
        const standalone = scoreColumn(column, fresh, scoreDayType);
        const incremental = scoreColumn(column, state, scoreDayType);
        insertColumn(column, state, threshold);
        cumulative += incremental.score;
        return {
          columnId: col.columnId,
          outboundDeparture: col.outboundDeparture,
          returnDeparture: col.returnDeparture,
          standaloneScore: round4(standalone.score),
          incrementalScore: round4(incremental.score),
          cumulative: round4(cumulative),
          ...pairOpeningHits(incremental.hits),
          byDirection: {
            outbound: round4(incremental.byDirection.outbound),
            return: round4(incremental.byDirection.return),
          },
          bands: column.bands,
        };
      });
      return { columns, cumulative: round4(cumulative) };
    };

    const weekdayEval = evaluateProposal("weekday", "weekday");
    doc.timetableColumns.forEach((col, i) => {
      col.columnScore = weekdayEval.columns[i].incrementalScore;
    });
    result.weekday.proposal = {
      columns: weekdayEval.columns,
      cumulative: weekdayEval.cumulative,
      basis:
        "timetabled departure times at each stop (proposedTimes); weekday BODS competitors; peak-filtered openings",
    };

    const weekendEval = evaluateProposal("saturday", "weekend");
    doc.timetableColumns.forEach((col, i) => {
      col.columnScoreWeekend = weekendEval.columns[i].incrementalScore;
    });
    result.weekend.proposal = {
      columns: weekendEval.columns,
      cumulative: weekendEval.cumulative,
      basis:
        "timetabled departure times at each stop (proposedTimes); Saturday BODS competitors; weekend peak-filtered openings",
    };
  }

  // ---- Fleet reference cap (§4.5 step 2): proposal fleet size — applied after demand greedy, not during it.
  const dead = deadLegAllowances(doc);
  const fleetCtx = fleetScheduleContext(ctx, dead);
  const proposalVehicles = doc.timetableColumns.length
    ? fleetCtx.vehiclesFor(
        doc.timetableColumns.map((c) => ({
          columnId: c.columnId,
          depotDeparture: parseHHMM(c.depotDeparture ?? c.outboundDeparture),
          depotArrival: parseHHMM(c.depotArrival ?? c.returnDeparture),
        })),
      )
    : null;
  const cap = config.fleet.recommendedFleetCap ?? proposalVehicles ?? null;
  const toSched = (c) => ({
    columnId: c.columnId,
    depotDeparture: parseHHMM(c.outboundDeparture) - dead.out,
    depotArrival: parseHHMM(c.returnArrival) + dead.in,
  });
  result.fleetCap = {
    cap,
    basis: config.fleet.recommendedFleetCap
      ? "config RECOMMENDED_FLEET_CAP"
      : "vehicles required by the proposed timetable (central energy scenario)",
    proposalVehicles,
    energyPerReturnKwh: fleetCtx.energyKwh,
  };

  // ---- Propose (weekday and weekend): slot ranking (web) + greedy recommend (CSV/schema) ---------
  const grid = [];
  for (let t = sel.gridStartMin; t <= sel.gridEndMin; t += sel.gridStepMin) grid.push(t);

  for (const [key, dayType, supplyDay] of [
    ["weekday", "weekday", "weekday"],
    ["weekend", "weekend", "saturday"],
  ]) {
    const baseState = buildState(ctx, supplyDay, threshold, dayType);
    const ranked = rankStandaloneSlots({
      departureGrid: grid,
      layovers: sel.layoversMin,
      offsets,
      state: baseState,
      tw,
      dayType,
    });
    const slotPick = selectSlotsByGapHits({
      departureGrid: grid,
      layovers: sel.layoversMin,
      offsets,
      state: cloneSelectionState(baseState),
      tw,
      thresholdMin: threshold,
      maxColumns: sel.maxColumns,
      minNewGapHits: sel.minNewGapHits,
      minSpacingMin: sel.minSpacingMin,
      dayType,
    });
    const vehiclesFor = (cols) =>
      cols.length ? fleetCtx.vehiclesFor(cols.map(toSched)) : 0;
    const selectedCols = slotPick.chosen.map((c, i) =>
      formatColumnRow(c, i, "S", {
        newGapHits: c.newGapHits,
        cumulativeGapHits: c.cumulativeGapHits,
      }),
    );
    result[key].slotRanking = {
      basis: `standalone gap-hit rank on ${supplyDay} BODS; K from incremental new pair hits (min ${sel.minNewGapHits}), spacing ≥ ${sel.minSpacingMin} min`,
      candidates: ranked.map((c, i) => formatColumnRow(c, i, "S", { rank: i + 1 })),
      selected: {
        columns: selectedCols,
        vehiclesRequired: vehiclesFor(selectedCols),
        curve: slotPick.curve,
        stopReason: slotPick.stopReason,
      },
    };

    const r = greedySelect({
      departureGrid: grid,
      layovers: sel.layoversMin,
      offsets,
      state: cloneSelectionState(baseState),
      tw,
      thresholdMin: threshold,
      maxColumns: sel.maxColumns,
      minMarginalGain: sel.minMarginalGain,
      minSpacingMin: sel.minSpacingMin,
      dayType,
    });
    const discovered = r.chosen.map((c, i) =>
      formatColumnRow(c, i, "R", {
        marginalGain: round4(c.marginalGain),
        cumulative: round4(c.cumulative),
        pairsInOpenings: c.hits,
        outboundPairsInOpenings: c.outboundHits,
        returnPairsInOpenings: c.returnHits,
      }),
    );
    const fit = fitFleetCap(discovered, cap, vehiclesFor);
    const fitCumulative = round4(
      fit.columns.reduce((s, c) => s + (c.marginalGain ?? 0), 0),
    );
    result[key].recommended = {
      basis: `modelled running times (coach factor ${ctx.velocity ? "central" : "from proposed timetable"}), competitor timelines for ${supplyDay}; demand greedy uncapped`,
      fleetCap: cap,
      vehiclesRequired: vehiclesFor(discovered),
      columns: discovered,
      curve: r.curve.map((p) => ({
        n: p.n,
        cumulative: round4(p.cumulative),
        marginal: round4(p.marginal),
      })),
      cumulative: round4(r.curve.at(-1)?.cumulative ?? 0),
      ...(cap != null
        ? {
            fleetFit: {
              cap,
              basis:
                "block scheduler (central energy): drop lowest-marginal discovered columns until ≤ fleet cap",
              columns: fit.columns,
              cumulative: fitCumulative,
              vehiclesRequired: fit.vehiclesRequired,
              dropped: fit.dropped.map((c) => ({
                columnId: c.columnId,
                outboundDeparture: c.outboundDeparture,
                marginalGain: c.marginalGain,
              })),
            },
          }
        : {}),
    };
  }

  doc.timetableSelection = result;
  log.info(
    {
      proposalCumulative: result.weekday.proposal?.cumulative,
      slotRankingWeekday: result.weekday.slotRanking?.selected?.columns?.length,
      slotRankingWeekend: result.weekend.slotRanking?.selected?.columns?.length,
      recommendedWeekday: result.weekday.recommended.columns.length,
      weekendRecommended: result.weekend.recommended.columns.length,
    },
    "timetable selection",
  );
  return ctx;
}

// ---------------------------------------------------------------------------------------------------

/** Passenger-stop arrival offsets per direction per window, rebased to the first passenger stop. */
function arrivalOffsets(ctx) {
  const { document: doc } = ctx;
  const out = { outbound: {}, return: {} };
  for (const d of DIRECTIONS) {
    const stops = doc.directions[d].orderedStops;
    const paxIdx = stops
      .map((s, i) => (s.role === "depot" ? -1 : i))
      .filter((i) => i >= 0);
    if (ctx.velocity?.[d]) {
      for (const [w, byFactor] of Object.entries(ctx.velocity[d].arrivals)) {
        const a = byFactor.central.arrivalOffsetsMin;
        out[d][w] = paxIdx.map((i) => a[i] - a[paxIdx[0]]);
      }
    } else {
      // Fallback: offsets implied by the proposed timetable's first column.
      const pax = passengerStops(doc.directions[d]);
      if (!pax[0]?.proposedTimes) return null;
      const t0 = parseHHMM(pax[0].proposedTimes[0]);
      const offs = pax.map((s) => parseHHMM(s.proposedTimes[0]) - t0);
      for (const sampleId of routingSamplesForDirection(doc.estimatedTemporalWindows, d))
        out[d][sampleId] = offs;
    }
  }
  return out;
}

/** Competitor timelines per pair with peak-filtered scoring gaps. */
function buildState(ctx, supplyDay, threshold, scoreDayType = supplyDay) {
  const { document: doc, config } = ctx;
  const dayStart = config.supply?.dayStartMin ?? DEFAULT_DAY_START_MIN;
  const dayEnd = config.supply?.dayEndMin ?? DEFAULT_DAY_END_MIN;
  const tw = doc.estimatedTemporalWindows;
  const trafficProfile = doc.trafficProfile;
  const peakDayType = scoreDayType === "weekend" ? "weekend" : "weekday";
  const state = {};
  for (const d of DIRECTIONS) {
    const dir = doc.directions[d];
    const pax = passengerStops(dir);
    const stopIndex = new Map(pax.map((s, i) => [s.naptanId, i]));
    const timelines = new Map();
    const gaps = new Map();
    const peakBands = peakBandsForDirection(tw, trafficProfile, d, peakDayType);
    for (const p of dir.directionalODPairs) {
      const ts = competitorDeparturesMinutes(p.supplyVector, supplyDay);
      timelines.set(p.pairId, ts);
      gaps.set(p.pairId, gapsFromTimeline(ts, threshold, dayStart, dayEnd, peakBands));
    }
    state[d] = {
      pairs: dir.directionalODPairs,
      stopIndex,
      timelines,
      gaps,
      thresholdMin: threshold,
      peakBands,
      dayStart,
      dayEnd,
    };
  }
  return state;
}

/** A supplied column as timetabled: departures at each passenger stop from proposedTimes[c]. */
function proposalColumn(doc, col, c, tw, dayType = "weekday") {
  const deps = {};
  for (const d of DIRECTIONS) {
    const pax = passengerStops(doc.directions[d]);
    deps[d] = pax.map((s) =>
      s.proposedTimes?.[c] !== undefined ? parseHHMM(s.proposedTimes[c]) : null,
    );
    if (deps[d].some((x) => x === null)) {
      // No per-stop times: fall back to first-stop departure + modelled offsets would need velocity; use departure only.
      deps[d] = pax.map((_, i) =>
        i === 0
          ? parseHHMM(d === "outbound" ? col.outboundDeparture : col.returnDeparture)
          : null,
      );
    }
  }
  const outboundDeparture = parseHHMM(col.outboundDeparture),
    returnDeparture = parseHHMM(col.returnDeparture);
  const outboundArrival = deps.outbound.at(-1) ?? outboundDeparture;
  const outBands = weekdayBands(tw, "outbound");
  const retBands = weekdayBands(tw, "return");
  return {
    outboundDeparture,
    outboundArrival,
    layoverMin: returnDeparture - outboundArrival,
    returnDeparture,
    returnArrival: deps.return.at(-1) ?? returnDeparture,
    bands: {
      outbound:
        dayType === "weekend" ? "weekend" : bandForDeparture(outboundDeparture, outBands),
      return:
        dayType === "weekend" ? "weekend" : bandForDeparture(returnDeparture, retBands),
    },
    departures: {
      outbound: deps.outbound.map((x) => x ?? Infinity),
      return: deps.return.map((x) => x ?? Infinity),
    },
  };
}

function cloneSelectionState(state) {
  const out = {};
  for (const d of DIRECTIONS) {
    const s = state[d];
    out[d] = {
      ...s,
      timelines: new Map([...s.timelines.entries()].map(([k, v]) => [k, [...v]])),
      gaps: new Map([...s.gaps.entries()].map(([k, v]) => [k, v.map((g) => ({ ...g }))])),
    };
  }
  return out;
}

function formatColumnRow(c, i, prefix, extra = {}) {
  return {
    ...(prefix === "S" ? { rank: extra.rank ?? i + 1 } : {}),
    columnId: extra.columnId ?? `${prefix}${String(i + 1).padStart(2, "0")}`,
    outboundDeparture: formatHHMM(c.outboundDeparture),
    outboundArrival: formatHHMM(c.outboundArrival),
    layoverMinutes: c.layoverMin,
    returnDeparture: formatHHMM(c.returnDeparture),
    returnArrival: formatHHMM(c.returnArrival),
    bands: c.bands,
    pairsInOpenings: extra.pairsInOpenings ?? c.pairsInOpenings ?? c.hits,
    outboundPairsInOpenings:
      extra.outboundPairsInOpenings ?? c.outboundPairsInOpenings ?? c.outboundHits,
    returnPairsInOpenings:
      extra.returnPairsInOpenings ?? c.returnPairsInOpenings ?? c.returnHits,
    ...extra,
  };
}

function pairOpeningHits(hits) {
  const list = hits ?? [];
  return {
    pairsInOpenings: list.length,
    outboundPairsInOpenings: list.filter((h) => h.direction === "outbound").length,
    returnPairsInOpenings: list.filter((h) => h.direction === "return").length,
  };
}
