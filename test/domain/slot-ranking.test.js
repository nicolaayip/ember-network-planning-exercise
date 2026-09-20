import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { directionState, gapsFromTimeline } from "../../src/domain/timetable-selection.js";
import { rankStandaloneSlots, selectSlotsByGapHits } from "../../src/domain/slot-ranking.js";

const bands = [
  { id: "peak1", kind: "peak", start: "07:30", end: "10:15", apex: "07:30" },
  { id: "valley1", kind: "valley", start: "10:15", end: "16:00", apex: "13:00" },
  { id: "peak2", kind: "peak", start: "16:00", end: "19:00", apex: "16:00" },
];
const peaks = bands.filter((b) => b.kind === "peak");
const tw = {
  outbound: { weekdayBands: bands, weekendDeparture: "11:00", weekendPeakBand: { id: "weekend", kind: "peak", start: "10:00", end: "15:00", apex: "12:00" } },
  return: { weekdayBands: bands, weekendDeparture: "14:00", weekendPeakBand: { id: "weekend", kind: "peak", start: "11:00", end: "16:00", apex: "13:00" } },
};
const offsets = { outbound: {}, return: {} };
for (const w of ["peak1", "valley1", "peak2", "weekend"]) {
  offsets.outbound[w] = [0, 60, 120];
  offsets.return[w] = [0, 60, 120];
}

const gap = (start, end) => [{ gapStart: `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`, gapEnd: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`, durationMinutes: end - start, isMarketOpening: true }];
const mkDir = (ids) => ({
  orderedStops: ids.map((id) => ({ naptanId: id })),
  directionalODPairs: [
    [0, 1], [0, 2], [1, 2],
  ].map(([i, j]) => ({
    pairId: `${ids[i]}->${ids[j]}`,
    originStopId: ids[i],
    destinationStopId: ids[j],
    demandVector: { offPeakWeekday: { calculatedWeekdayGravityPotential: 100 }, offPeakWeekend: { calculatedWeekendGravityPotential: 100 } },
    supplyVector: { competitorDepartures: [], calculatedHeadwayGaps: gap(7 * 60 + 30, 10 * 60 + 15) },
  })),
});

function buildPairState() {
  const dir = mkDir(["A", "B", "C"]);
  const out = directionState(dir, 60, { peakBands: peaks });
  const ret = directionState({ ...dir, directionalODPairs: dir.directionalODPairs.map((p) => ({ ...p, pairId: p.pairId.replace("->", "<-") })) }, 60, { peakBands: peaks });
  return { outbound: out, return: ret };
}

describe("rankStandaloneSlots", () => {
  test("ranks candidates by total gap hits", () => {
    const state = buildPairState();
    const ranked = rankStandaloneSlots({
      departureGrid: [8 * 60, 9 * 60],
      layovers: [45],
      offsets,
      state,
      tw,
      dayType: "weekday",
    });
    assert.equal(ranked.length, 2);
    assert.ok(ranked[0].pairsInOpenings >= ranked[1].pairsInOpenings);
    assert.ok(ranked.every((r) => r.outboundPairsInOpenings + r.returnPairsInOpenings === r.pairsInOpenings));
  });
});

describe("selectSlotsByGapHits", () => {
  test("stops when incremental new hits fall below threshold", () => {
    const state = buildPairState();
    const r = selectSlotsByGapHits({
      departureGrid: [8 * 60 + 30, 9 * 60, 17 * 60],
      layovers: [45],
      offsets,
      state,
      tw,
      thresholdMin: 60,
      maxColumns: 12,
      minNewGapHits: 1,
      minSpacingMin: 60,
      dayType: "weekday",
    });
    assert.ok(r.chosen.length >= 1);
    assert.equal(r.chosen[0].newGapHits, r.chosen[0].pairsInOpenings);
    assert.ok(["min_new_gap_hits", "max_columns", "no_candidates"].includes(r.stopReason));
  });
});
