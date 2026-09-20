import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { headwayGaps, toSchemaGaps, summariseGaps, DEFAULT_DAY_START_MIN, DEFAULT_DAY_END_MIN } from "../../src/domain/headway.js";

const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

describe("headwayGaps", () => {
  test("brief example: 07:00 / 09:30 / 10:00 → gaps 150 and 30, one market opening at threshold 120", () => {
    const gaps = headwayGaps([hm("07:00"), hm("09:30"), hm("10:00")], { thresholdMinutes: 120, includeEdges: false });
    assert.deepEqual(gaps.map((g) => g.durationMinutes), [150, 30]);
    assert.deepEqual(gaps.map((g) => g.isMarketOpening), [true, false]);
    assert.equal(gaps[0].gapStart, "07:00");
    assert.equal(gaps[0].gapEnd, "09:30");
    assert.equal(gaps[1].gapStart, "09:30");
    assert.equal(gaps[1].gapEnd, "10:00");
  });

  test("edge gaps: day 05:00–23:00 around the same three departures adds 120 (not an opening, > not ≥) and 780", () => {
    const gaps = headwayGaps([hm("07:00"), hm("09:30"), hm("10:00")], { thresholdMinutes: 120 });
    assert.deepEqual(gaps.map((g) => g.durationMinutes), [120, 150, 30, 780]);
    assert.deepEqual(gaps.map((g) => g.isMarketOpening), [false, true, false, true]);
    assert.deepEqual(gaps.map((g) => g.isEdge), [true, false, false, true]);
    assert.equal(gaps[0].gapStart, "05:00");
    assert.equal(gaps.at(-1).gapEnd, "23:00");
    assert.equal(DEFAULT_DAY_START_MIN, 300);
    assert.equal(DEFAULT_DAY_END_MIN, 1380);
  });

  test("unsorted input with duplicates is sorted and de-duplicated", () => {
    const gaps = headwayGaps([hm("10:00"), hm("07:00"), hm("09:30"), hm("07:00")], { thresholdMinutes: 60, includeEdges: false });
    assert.deepEqual(gaps.map((g) => g.durationMinutes), [150, 30]);
  });

  test("no departures → a single whole-day gap flagged as an opening", () => {
    const gaps = headwayGaps([], { thresholdMinutes: 120, dayStartMin: hm("06:00"), dayEndMin: hm("22:00") });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].durationMinutes, 960);
    assert.equal(gaps[0].isMarketOpening, true);
    assert.equal(gaps[0].gapStart, "06:00");
    assert.equal(gaps[0].gapEnd, "22:00");
  });

  test("service-day notation: a 25:22 departure formats as 25:22 and the trailing edge is dropped when past day end", () => {
    const gaps = headwayGaps([hm("22:00"), hm("25:22")], { thresholdMinutes: 120 });
    assert.deepEqual(gaps.map((g) => g.durationMinutes), [1020, 202]);
    assert.equal(gaps[1].gapEnd, "25:22");
    assert.equal(gaps[1].isMarketOpening, true);
  });

  test("threshold is required", () => {
    assert.throws(() => headwayGaps([1, 2], {}), TypeError);
  });
});

describe("toSchemaGaps / summariseGaps", () => {
  test("schema copy keeps exactly the four DATA_SCHEMA fields", () => {
    const gaps = headwayGaps([hm("07:00"), hm("09:30"), hm("10:00")], { thresholdMinutes: 120, includeEdges: false });
    const schema = toSchemaGaps(gaps);
    assert.deepEqual(Object.keys(schema[0]).sort(), ["durationMinutes", "gapEnd", "gapStart", "isMarketOpening"]);
    assert.deepEqual(schema[0], { gapStart: "07:00", gapEnd: "09:30", durationMinutes: 150, isMarketOpening: true });
  });

  test("summary: 4 gaps, 2 openings (150 + 780) totalling 930 minutes, longest 780", () => {
    const gaps = headwayGaps([hm("07:00"), hm("09:30"), hm("10:00")], { thresholdMinutes: 120 });
    assert.deepEqual(summariseGaps(gaps), { gaps: 4, marketOpenings: 2, openingMinutes: 930, longestGapMinutes: 780 });
  });
});
