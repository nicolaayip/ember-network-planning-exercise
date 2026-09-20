import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  intersectGapWithBands,
  qualifyMarketOpenings,
  annotateRawGaps,
  peakBandsForDirection,
  gapsForTimeline,
} from "../../src/domain/market-openings.js";
import { headwayGaps } from "../../src/domain/headway.js";

const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

const peak1 = { id: "peak1", kind: "peak", start: "06:45", end: "10:45", apex: "08:00" };
const peak2 = { id: "peak2", kind: "peak", start: "13:30", end: "18:15", apex: "16:00" };
const peaks = [peak1, peak2];

describe("intersectGapWithBands", () => {
  test("clips gap to peak band overlap", () => {
    const inter = intersectGapWithBands(hm("05:00"), hm("08:38"), peaks);
    assert.equal(inter.length, 1);
    assert.equal(inter[0].start, hm("06:45"));
    assert.equal(inter[0].end, hm("08:38"));
    assert.equal(inter[0].minutes, 113);
  });
});

describe("qualifyMarketOpenings", () => {
  test("excludes edge gaps even when long", () => {
    const raw = headwayGaps([hm("08:38")], { thresholdMinutes: 60 });
    const openings = qualifyMarketOpenings(raw, peaks, 60);
    assert.equal(openings.length, 0, "leading and trailing edges excluded");
  });

  test("interior gap overlapping peak by ≥60 min qualifies", () => {
    const raw = headwayGaps([hm("07:00"), hm("11:00")], { thresholdMinutes: 60, includeEdges: false });
    const openings = qualifyMarketOpenings(raw, peaks, 60);
    assert.equal(openings.length, 1);
    assert.equal(openings[0].start, hm("07:00"));
    assert.equal(openings[0].end, hm("10:45"));
    assert.ok(openings[0].minutes >= 60);
  });

  test("valley-only gap does not qualify", () => {
    const raw = headwayGaps([hm("11:00"), hm("13:00")], { thresholdMinutes: 60, includeEdges: false });
    const openings = qualifyMarketOpenings(raw, peaks, 60);
    assert.equal(openings.length, 0);
  });

  test("unserved pair uses peak bands as openings", () => {
    const openings = qualifyMarketOpenings([], peaks, 60, { unserved: true });
    assert.equal(openings.length, 2);
    assert.ok(openings.every((o) => o.minutes > 60));
  });
});

describe("annotateRawGaps", () => {
  test("marks isMarketOpening from peak overlap, not raw duration", () => {
    const raw = headwayGaps([hm("07:00"), hm("09:30"), hm("10:00")], { thresholdMinutes: 60 });
    const annotated = annotateRawGaps(raw, peaks, 60);
    const edge = annotated.find((g) => g.gapStart === "05:00");
    assert.equal(edge.isMarketOpening, false);
    const interior = annotated.find((g) => g.gapStart === "07:00" && g.gapEnd === "09:30");
    assert.equal(interior.isMarketOpening, true);
  });
});

describe("peakBandsForDirection", () => {
  const tw = {
    outbound: {
      weekdayBands: [{ id: "peak1", kind: "peak", start: "07:00", end: "10:00", apex: "08:00" }, { id: "valley1", kind: "valley", start: "10:00", end: "16:00", apex: "13:00" }],
      weekendPeakBand: { id: "weekend", kind: "peak", start: "10:00", end: "15:00", apex: "12:00" },
    },
    return: { weekdayBands: [], weekendPeakBand: { id: "weekend", kind: "peak", start: "11:00", end: "16:00", apex: "13:00" } },
  };

  test("weekday returns peak bands only", () => {
    assert.equal(peakBandsForDirection(tw, null, "outbound", "weekday").length, 1);
    assert.equal(peakBandsForDirection(tw, null, "outbound", "weekday")[0].id, "peak1");
  });

  test("weekend returns weekendPeakBand", () => {
    assert.equal(peakBandsForDirection(tw, null, "outbound", "weekend")[0].id, "weekend");
  });
});

describe("gapsForTimeline", () => {
  test("empty timeline yields peak-band schema gaps for unserved", () => {
    const { schemaGaps, scoringGaps } = gapsForTimeline([], peaks, 60);
    assert.ok(schemaGaps.every((g) => g.isMarketOpening));
    assert.equal(scoringGaps.length, 2);
  });
});
