import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildColumn } from "../../src/domain/timetable-selection.js";
import { directionState } from "../../src/domain/timetable-selection.js";
import {
  buildChainCatalog,
  canChainColumns,
  compareChainCandidates,
  selectSlotsByGapHitsWithChains,
} from "../../src/domain/slot-chains.js";

const bands = [
  { id: "peak1", kind: "peak", start: "07:30", end: "10:15", apex: "07:30" },
  { id: "valley1", kind: "valley", start: "10:15", end: "16:00", apex: "13:00" },
  { id: "peak2", kind: "peak", start: "16:00", end: "19:00", apex: "16:00" },
];
const peaks = bands.filter((b) => b.kind === "peak");
const tw = {
  outbound: {
    weekdayBands: bands,
    weekendDeparture: "11:00",
    weekendPeakBand: { id: "weekend", kind: "peak", start: "10:00", end: "15:00", apex: "12:00" },
  },
  return: {
    weekdayBands: bands,
    weekendDeparture: "14:00",
    weekendPeakBand: { id: "weekend", kind: "peak", start: "11:00", end: "16:00", apex: "13:00" },
  },
};
const offsets = { outbound: {}, return: {} };
for (const w of ["peak1", "valley1", "peak2", "weekend"]) {
  offsets.outbound[w] = [0, 60, 120];
  offsets.return[w] = [0, 60, 120];
}

const vehicle = { batteryKwh: 621, maxChargePowerKw: 600, socFloor: 0.1 };
const site = { cables: 4, cablePowerKw: 180, maxCablesPerVehicle: 2, plugHandlingMinutes: 10 };
const fleetCtx = { energyPerReturnKwh: 100, vehicle, site, deadOut: 15, deadIn: 15 };

const gap = (start, end) => [
  {
    gapStart: `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
    gapEnd: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
    durationMinutes: end - start,
    isMarketOpening: true,
  },
];
const mkDir = (ids) => ({
  orderedStops: ids.map((id) => ({ naptanId: id })),
  directionalODPairs: [
    [0, 1],
    [0, 2],
    [1, 2],
  ].map(([i, j]) => ({
    pairId: `${ids[i]}->${ids[j]}`,
    originStopId: ids[i],
    destinationStopId: ids[j],
    demandVector: {
      offPeakWeekday: { calculatedWeekdayGravityPotential: 100 },
      offPeakWeekend: { calculatedWeekendGravityPotential: 100 },
    },
    supplyVector: {
      competitorDepartures: [],
      calculatedHeadwayGaps: gap(7 * 60 + 30, 10 * 60 + 15),
    },
  })),
});

function buildPairState() {
  const dir = mkDir(["A", "B", "C"]);
  const out = directionState(dir, 60, { peakBands: peaks });
  const ret = directionState(
    {
      ...dir,
      directionalODPairs: dir.directionalODPairs.map((p) => ({
        ...p,
        pairId: p.pairId.replace("->", "<-"),
      })),
    },
    60,
    { peakBands: peaks },
  );
  return { outbound: out, return: ret };
}

describe("canChainColumns", () => {
  test("allows second departure after recharge window", () => {
    const morning = buildColumn(8 * 60 + 30, 45, offsets, tw, "weekday");
    const afternoon = buildColumn(17 * 60, 45, offsets, tw, "weekday");
    assert.equal(canChainColumns(morning, afternoon, fleetCtx), true);
  });

  test("rejects overlapping depot windows", () => {
    const a = buildColumn(8 * 60 + 30, 45, offsets, tw, "weekday");
    const b = buildColumn(9 * 60, 45, offsets, tw, "weekday");
    assert.equal(canChainColumns(a, b, fleetCtx), false);
  });
});

describe("compareChainCandidates", () => {
  test("prefers higher combined hits, then hits per chain", () => {
    assert.ok(compareChainCandidates({ newGapHits: 10, hitsPerChain: 5, kind: "chain", outboundDeparture: 0 }, { newGapHits: 8, hitsPerChain: 8, kind: "single", outboundDeparture: 0 }) < 0);
    assert.ok(compareChainCandidates({ newGapHits: 8, hitsPerChain: 8, kind: "chain", outboundDeparture: 0 }, { newGapHits: 8, hitsPerChain: 4, kind: "single", outboundDeparture: 0 }) < 0);
    assert.ok(compareChainCandidates({ newGapHits: 6, hitsPerChain: 6, kind: "chain", outboundDeparture: 0 }, { newGapHits: 6, hitsPerChain: 6, kind: "single", outboundDeparture: 0 }) < 0);
  });
});

describe("buildChainCatalog", () => {
  test("indexes chains by time — far fewer than n×(n−1)", () => {
    const grid = [];
    for (let t = 300; t <= 1260; t += 15) grid.push(t);
    const { singles, chainCount } = buildChainCatalog({
      departureGrid: grid,
      layovers: [45, 60, 75, 90],
      offsets,
      tw,
      dayType: "weekday",
      fleetCtx,
    });
    const naive = singles.length * (singles.length - 1);
    assert.ok(chainCount < naive / 4, `expected indexed chains ≪ naive; got ${chainCount} vs ${naive}`);
    assert.ok(chainCount > 0);
  });
});

describe("selectSlotsByGapHitsWithChains", () => {
  test("assigns vehicleDay and may pick chains", () => {
    const state = buildPairState();
    const r = selectSlotsByGapHitsWithChains({
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
      fleetCtx,
    });
    assert.ok(r.chosen.length >= 1);
    assert.ok(r.chosen.every((c) => c.vehicleDay >= 1));
    assert.ok(r.curve.some((p) => p.vehicleDays != null));
    const chained = r.chosen.filter((c) => c.chainKind === "chain");
    if (chained.length) {
      const days = new Set(chained.map((c) => c.vehicleDay));
      assert.ok([...days].some((d) => chained.filter((c) => c.vehicleDay === d).length === 2));
    }
  });
});
