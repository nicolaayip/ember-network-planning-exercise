/**
 * Chain-aware slot selection for suggested timetables.
 *
 * Pairs round-trip columns that can share one vehicle (return + recharge + next outbound),
 * scores chains by sequential incremental gap hits, ranks by combined hits then hits per chain.
 *
 * @format
 */

import { FULL_SOC } from "./energy.js";
import { chargeTime } from "./charging.js";
import {
  buildColumn,
  scoreColumn,
  insertColumn,
} from "./timetable-selection.js";

function cloneState(state) {
  const out = {};
  for (const dir of ["outbound", "return"]) {
    const s = state[dir];
    out[dir] = {
      ...s,
      timelines: new Map([...s.timelines.entries()].map(([k, v]) => [k, [...v]])),
      gaps: new Map([...s.gaps.entries()].map(([k, v]) => [k, v.map((g) => ({ ...g }))])),
    };
  }
  return out;
}

function hitsFromScore(s) {
  const list = s.hits ?? [];
  return {
    pairsInOpenings: list.length,
    outboundPairsInOpenings: list.filter((h) => h.direction === "outbound").length,
    returnPairsInOpenings: list.filter((h) => h.direction === "return").length,
  };
}

export function columnKey(col) {
  return `${col.outboundDeparture}:${col.layoverMin}`;
}

/** Minimum depot recharge minutes after one return (central energy scenario). */
export function minRechargeMinutes(fleetCtx) {
  const { energyPerReturnKwh, vehicle, site } = fleetCtx;
  if (energyPerReturnKwh > vehicle.batteryKwh) return Infinity;
  const socOnReturn = FULL_SOC - energyPerReturnKwh / vehicle.batteryKwh;
  return chargeTime({
    socFrom: socOnReturn,
    socTo: FULL_SOC,
    cables: site.maxCablesPerVehicle,
    site,
    vehicle,
  }).minutes;
}

/** Depot departure/arrival minutes for block scheduling. */
export function depotTimes(column, deadOut, deadIn) {
  return {
    depotDeparture: column.outboundDeparture - deadOut,
    depotArrival: column.returnArrival + deadIn,
  };
}

/**
 * True if `second` can follow `first` on one vehicle (enough depot recharge time).
 * @param {object} fleetCtx  energyPerReturnKwh, vehicle, site, deadOut, deadIn
 */
export function canChainColumns(first, second, fleetCtx) {
  const { deadOut, deadIn } = fleetCtx;
  const chargeMin = minRechargeMinutes(fleetCtx);
  if (!Number.isFinite(chargeMin)) return false;

  const end1 = first.returnArrival + deadIn;
  const start2 = second.outboundDeparture - deadOut;
  return start2 > end1 && start2 >= end1 + chargeMin;
}

/** Incremental gap hits for a column or ordered chain against current competitor state. */
export function scoreIncrementalChain(columns, state, dayType, thresholdMin) {
  const working = cloneState(state);
  let newGapHits = 0;
  const perLeg = [];
  for (const col of columns) {
    const s = scoreColumn(col, working, dayType);
    perLeg.push({ col, s, newGapHits: s.hits.length, ...hitsFromScore(s) });
    newGapHits += s.hits.length;
    insertColumn(col, working, thresholdMin);
  }
  const chainLength = columns.length;
  return {
    columns,
    perLeg,
    newGapHits,
    hitsPerChain: chainLength ? newGapHits / chainLength : 0,
  };
}

/**
 * Compare candidates: max combined gap hits, then max gap hits per chain, then prefer chains.
 */
export function compareChainCandidates(a, b) {
  return (
    b.newGapHits - a.newGapHits ||
    b.hitsPerChain - a.hitsPerChain ||
    (b.kind === "chain" ? 1 : 0) - (a.kind === "chain" ? 1 : 0) ||
    a.outboundDeparture - b.outboundDeparture
  );
}

function lowerBoundDepotStart(entries, minDepotStart) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].depotStart < minDepotStart) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Build grid columns and time-indexed feasible two-leg chains.
 * Chains are keyed by first column; only seconds with depotStart ≥ first depotEnd + recharge are considered.
 */
export function buildChainCatalog({ departureGrid, layovers, offsets, tw, dayType, fleetCtx }) {
  const { deadOut, deadIn } = fleetCtx;
  const chargeMin = minRechargeMinutes(fleetCtx);

  const entries = [];
  for (const dep of departureGrid) {
    for (const lay of layovers) {
      const col = buildColumn(dep, lay, offsets, tw, dayType);
      entries.push({
        col,
        key: columnKey(col),
        depotEnd: col.returnArrival + deadIn,
        depotStart: col.outboundDeparture - deadOut,
      });
    }
  }

  entries.sort((a, b) => a.depotStart - b.depotStart || a.depotEnd - b.depotEnd);

  const chainsFromFirst = new Map();
  let chainCount = 0;
  if (Number.isFinite(chargeMin)) {
    for (const first of entries) {
      const from = lowerBoundDepotStart(entries, first.depotEnd + chargeMin);
      const seconds = [];
      for (let j = from; j < entries.length; j++) {
        const second = entries[j];
        if (first.key === second.key) continue;
        seconds.push({
          first: first.col,
          second: second.col,
          firstKey: first.key,
          secondKey: second.key,
          chainKey: `${first.key}+${second.key}`,
        });
      }
      if (seconds.length) {
        chainsFromFirst.set(first.key, seconds);
        chainCount += seconds.length;
      }
    }
  }

  return {
    singles: entries.map((e) => e.col),
    singleKeys: entries.map((e) => e.key),
    chainsFromFirst,
    chainCount,
  };
}

function spacingOk(chosen, outboundDeparture, minSpacing) {
  return !chosen.some((c) => Math.abs(c.outboundDeparture - outboundDeparture) < minSpacing);
}

/**
 * Greedily pick slots, preferring chain rows when they win on combined hits then hits/chain.
 * @returns same shape as selectSlotsByGapHits, with vehicleDay on chosen columns
 */
export function selectSlotsByGapHitsWithChains(p) {
  const dayType = p.dayType ?? "weekday";
  const minNew = p.minNewGapHits ?? 5;
  const minSpacing = p.minSpacingMin ?? 1;
  const fleetCtx = p.fleetCtx;
  const { singles, singleKeys, chainsFromFirst } = buildChainCatalog({
    departureGrid: p.departureGrid,
    layovers: p.layovers,
    offsets: p.offsets,
    tw: p.tw,
    dayType,
    fleetCtx,
  });

  const chosen = [];
  const curve = [];
  let cumulativeHits = 0;
  let vehicleDay = 0;
  const usedKeys = new Set();

  for (let round = 1; round <= p.maxColumns; round++) {
    let best = null;

    for (let i = 0; i < singles.length; i++) {
      const col = singles[i];
      const key = singleKeys[i];
      if (usedKeys.has(key)) continue;
      if (!spacingOk(chosen, col.outboundDeparture, minSpacing)) continue;
      const scored = scoreIncrementalChain([col], p.state, dayType, p.thresholdMin);
      const cand = {
        kind: "single",
        chainLength: 1,
        outboundDeparture: col.outboundDeparture,
        newGapHits: scored.newGapHits,
        hitsPerChain: scored.hitsPerChain,
        scored,
      };
      if (!best || compareChainCandidates(cand, best) < 0) best = cand;
    }

    for (const [firstKey, chainList] of chainsFromFirst) {
      if (usedKeys.has(firstKey)) continue;
      for (const chain of chainList) {
        if (usedKeys.has(chain.secondKey)) continue;
        const { first, second } = chain;
        if (!spacingOk(chosen, first.outboundDeparture, minSpacing)) continue;
        if (!spacingOk(chosen, second.outboundDeparture, minSpacing)) continue;
        const scored = scoreIncrementalChain([first, second], p.state, dayType, p.thresholdMin);
        const cand = {
          kind: "chain",
          chainLength: 2,
          outboundDeparture: first.outboundDeparture,
          newGapHits: scored.newGapHits,
          hitsPerChain: scored.hitsPerChain,
          scored,
          chainKey: chain.chainKey,
          firstKey: chain.firstKey,
          secondKey: chain.secondKey,
        };
        if (!best || compareChainCandidates(cand, best) < 0) best = cand;
      }
    }

    if (!best) return { chosen, curve, stopReason: "no_candidates" };
    if (best.newGapHits < minNew) {
      return {
        chosen,
        curve,
        stopReason: chosen.length ? "min_new_gap_hits" : "below_threshold",
      };
    }

    vehicleDay += 1;
    for (const leg of best.scored.perLeg) {
      cumulativeHits += leg.newGapHits;
      chosen.push({
        ...leg.col,
        ...hitsFromScore(leg.s),
        newGapHits: leg.newGapHits,
        cumulativeGapHits: cumulativeHits,
        vehicleDay,
        chainLength: best.chainLength,
        chainKind: best.kind,
      });
      insertColumn(leg.col, p.state, p.thresholdMin);
    }

    if (best.kind === "chain") {
      usedKeys.add(best.chainKey);
      usedKeys.add(best.firstKey);
      usedKeys.add(best.secondKey);
    } else {
      usedKeys.add(columnKey(best.scored.perLeg[0].col));
    }

    curve.push({
      n: chosen.length,
      vehicleDays: vehicleDay,
      newHits: best.newGapHits,
      cumulativeHits,
      kind: best.kind,
    });

    if (chosen.length >= p.maxColumns) {
      return { chosen, curve, stopReason: "max_columns" };
    }
  }
  return { chosen, curve, stopReason: "max_columns" };
}
