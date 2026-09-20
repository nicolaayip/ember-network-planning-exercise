/**
 * Bottom-up candidate slot ranking (DESIGN_DOC §4.5 supplement).
 *
 * 1. Rank every grid x layover column by standalone Out + Ret gap hits (competitor-only state).
 * 2. Select K columns by incremental new pair hits (not weighted coverage), with spacing.
 * 3. Fleet implication follows from K via the block scheduler (pipeline step 9).
 *
 * @format
 */

import { buildColumn, scoreColumn, insertColumn } from "./timetable-selection.js";

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

/**
 * Score every departure x layover on a fresh copy of `state` (competitors only).
 * @returns {Array<object>} sorted by total gap hits descending
 */
export function rankStandaloneSlots({
  departureGrid,
  layovers,
  offsets,
  state,
  tw,
  dayType = "weekday",
}) {
  const rows = [];
  for (const dep of departureGrid) {
    for (const lay of layovers) {
      const col = buildColumn(dep, lay, offsets, tw, dayType);
      const s = scoreColumn(col, cloneState(state), dayType);
      rows.push({
        outboundDeparture: dep,
        outboundArrival: col.outboundArrival,
        layoverMin: lay,
        returnDeparture: col.returnDeparture,
        returnArrival: col.returnArrival,
        bands: col.bands,
        ...hitsFromScore(s),
      });
    }
  }
  rows.sort(
    (a, b) =>
      b.pairsInOpenings - a.pairsInOpenings ||
      b.outboundPairsInOpenings - a.outboundPairsInOpenings ||
      b.returnPairsInOpenings - a.returnPairsInOpenings ||
      a.outboundDeparture - b.outboundDeparture ||
      a.layoverMin - b.layoverMin,
  );
  return rows;
}

/**
 * Greedily pick up to `maxColumns` spaced slots, maximising incremental new pair hits each round.
 * @param {object} p
 * @param {object} p.state  competitor-only state (mutated)
 * @param {number} [p.minNewGapHits=5]  stop when the best remaining column adds fewer pair hits
 * @returns {{ chosen: object[], curve: object[], stopReason: string }}
 */
export function selectSlotsByGapHits(p) {
  const dayType = p.dayType ?? "weekday";
  const minNew = p.minNewGapHits ?? 5;
  const minSpacing = p.minSpacingMin ?? 1;
  const chosen = [];
  const curve = [];
  let cumulativeHits = 0;

  for (let n = 1; n <= p.maxColumns; n++) {
    let best = null;
    for (const dep of p.departureGrid) {
      for (const lay of p.layovers) {
        if (chosen.some((c) => Math.abs(c.outboundDeparture - dep) < minSpacing))
          continue;
        const col = buildColumn(dep, lay, p.offsets, p.tw, dayType);
        const s = scoreColumn(col, p.state, dayType);
        const newHits = s.hits.length;
        if (
          !best ||
          newHits > best.newHits ||
          (newHits === best.newHits && s.score > best.score)
        ) {
          best = { col, s, newHits };
        }
      }
    }
    if (!best) return { chosen, curve, stopReason: "no_candidates" };
    if (best.newHits < minNew) {
      return {
        chosen,
        curve,
        stopReason: chosen.length ? "min_new_gap_hits" : "below_threshold",
      };
    }

    insertColumn(best.col, p.state, p.thresholdMin);
    cumulativeHits += best.newHits;
    chosen.push({
      ...best.col,
      ...hitsFromScore(best.s),
      newGapHits: best.newHits,
      cumulativeGapHits: cumulativeHits,
    });
    curve.push({ n: chosen.length, newHits: best.newHits, cumulativeHits });
  }
  return { chosen, curve, stopReason: "max_columns" };
}
