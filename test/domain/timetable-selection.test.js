import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  bandForDeparture, demandWeights, gapsFromTimeline, inMarketOpening, captureFactor, buildColumn, scoreColumn, insertColumn, greedySelect, directionState,
} from "../../src/domain/timetable-selection.js";

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
const gapOpts = { peakBands: peaks };

describe("bandForDeparture", () => {
  test("classifies departures into detected bands", () => {
    assert.equal(bandForDeparture(7 * 60 + 45, bands), "peak1");
    assert.equal(bandForDeparture(12 * 60, bands), "valley1");
    assert.equal(bandForDeparture(17 * 60, bands), "peak2");
    assert.equal(bandForDeparture(21 * 60, bands), "valley1", "outside bands falls back to valley");
    assert.equal(bandForDeparture(25 * 60, bands), "valley1", "service-day wrap");
  });
});

describe("gapsFromTimeline", () => {
  test("07:00 / 09:30 / 10:00 — peak-filtered openings only", () => {
    const g = gapsFromTimeline([420, 570, 600], 60, 300, 1380, peaks);
    assert.equal(g.length, 1);
    assert.equal(g[0].start, 7 * 60 + 30);
    assert.equal(g[0].end, 570);
    assert.equal(g[0].minutes, 120);
  });

  test("empty timeline yields peak-band openings for unserved", () => {
    const g = gapsFromTimeline([], 60, 300, 1380, peaks);
    assert.equal(g.length, 2);
    assert.ok(g.every((x) => x.isMarketOpening));
  });

  test("inMarketOpening is strict-interior on peak-qualified opening", () => {
    const g = gapsFromTimeline([420, 600], 60, 300, 1380, peaks);
    const opening = g.find((x) => x.isMarketOpening);
    assert.ok(opening);
    assert.equal(inMarketOpening(g, (opening.start + opening.end) / 2), true);
    assert.equal(inMarketOpening(g, opening.start), false);
    assert.equal(inMarketOpening(g, opening.end), false);
  });
});

describe("demandWeights", () => {
  const pairs = [
    { pairId: "A", demandVector: { offPeakWeekday: { calculatedWeekdayGravityPotential: 1000 }, offPeakWeekend: { calculatedWeekendGravityPotential: 300 } } },
    { pairId: "B", demandVector: { offPeakWeekday: { calculatedWeekdayGravityPotential: 3000 }, offPeakWeekend: { calculatedWeekendGravityPotential: 100 } } },
  ];
  test("weekday bands use gravity; weekend uses weekend gravity; shares sum to 1", () => {
    const peak = demandWeights(pairs, "weekday");
    assert.deepEqual([peak.get("A"), peak.get("B")], [0.25, 0.75]);
    const off = demandWeights(pairs, "weekday");
    assert.deepEqual([off.get("A"), off.get("B")], [0.25, 0.75]);
    const we = demandWeights(pairs, "weekend");
    assert.deepEqual([we.get("A"), we.get("B")], [0.75, 0.25]);
  });
});

const offsets = { outbound: {}, return: {} };
for (const w of ["peak1", "valley1", "peak2", "weekend"]) { offsets.outbound[w] = [0, 60, 120]; offsets.return[w] = [0, 60, 120]; }
const mkDir = (ids, gapsByPair) => ({
  orderedStops: ids.map((id) => ({ naptanId: id })),
  directionalODPairs: [
    [0, 1], [0, 2], [1, 2],
  ].map(([i, j]) => ({
    pairId: `${ids[i]}->${ids[j]}`, originStopId: ids[i], destinationStopId: ids[j],
    demandVector: { offPeakWeekday: { calculatedWeekdayGravityPotential: 100 }, offPeakWeekend: { calculatedWeekendGravityPotential: 100 } },
    supplyVector: {
      detectedOverlappingLines: [],
      calculatedHeadwayGaps: gapsByPair[`${ids[i]}->${ids[j]}`] ?? [],
      competitorDepartures: [],
    },
  })),
});

describe("buildColumn / scoreColumn / greedySelect", () => {
  test("buildColumn derives return departure from outbound arrival + layover", () => {
    const c = buildColumn(420, 45, offsets, tw);
    assert.equal(c.outboundArrival, 540);
    assert.equal(c.returnDeparture, 585);
    assert.equal(c.returnArrival, 705);
    assert.deepEqual(c.departures.outbound, [420, 480, 540]);
  });

  test("a column scores pairs landing in peak-filtered openings", () => {
    const out = mkDir(["O0", "O1", "O2"], { "O0->O2": [
      { gapStart: "07:00", gapEnd: "10:15", durationMinutes: 195, isMarketOpening: true },
    ] });
    const ret = mkDir(["R0", "R1", "R2"], {});
    const state = {
      outbound: directionState(out, 60, gapOpts),
      return: directionState(ret, 60, gapOpts),
    };
    const col = buildColumn(9 * 60, 45, offsets, tw);
    const s = scoreColumn(col, state);
    assert.ok(s.score > 0);
    insertColumn(col, state, 60);
    const again = scoreColumn(col, state);
    assert.equal(again.score, 0);
  });

  test("greedySelect returns a monotone cumulative curve on unserved peak bands", () => {
    const out = mkDir(["O0", "O1", "O2"], {});
    const ret = mkDir(["R0", "R1", "R2"], {});
    const state = {
      outbound: directionState(out, 60, gapOpts),
      return: directionState(ret, 60, gapOpts),
    };
    const grid = Array.from({ length: 17 }, (_, i) => 6 * 60 + i * 60);
    const r = greedySelect({ departureGrid: grid, layovers: [45, 60], offsets, state, tw, thresholdMin: 60, maxColumns: 5 });
    assert.ok(r.chosen.length > 0);
    for (let i = 1; i < r.curve.length; i++) assert.ok(r.curve[i].cumulative >= r.curve[i - 1].cumulative - 1e-9);
  });

  test("an acceptor can veto candidates (fleet-aware selection)", () => {
    const out = mkDir(["O0", "O1", "O2"], {});
    const ret = mkDir(["R0", "R1", "R2"], {});
    const state = {
      outbound: directionState(out, 60, gapOpts),
      return: directionState(ret, 60, gapOpts),
    };
    const grid = Array.from({ length: 17 }, (_, i) => 6 * 60 + i * 60);
    const r = greedySelect({ departureGrid: grid, layovers: [45], offsets, state, tw, thresholdMin: 60, maxColumns: 4, accept: (c) => (c.outboundDeparture / 60) % 2 === 0 });
    assert.equal(r.chosen.length, 4);
    assert.ok(r.chosen.every((c) => (c.outboundDeparture / 60) % 2 === 0));
    assert.ok(r.rejectedByAccept > 0);
  });

  test("captureFactor uses peak-qualified opening duration", () => {
    const g = [{ start: 420, end: 615, minutes: 195, isMarketOpening: true }];
    assert.ok(Math.abs(captureFactor(g, 500, 60) - (195 - 60) / 195) < 1e-9);
    const tight = [{ start: 420, end: 480, minutes: 60, isMarketOpening: true }];
    assert.equal(captureFactor(tight, 450, 60), 0, "60-min opening at threshold = 0 factor");
  });
});
