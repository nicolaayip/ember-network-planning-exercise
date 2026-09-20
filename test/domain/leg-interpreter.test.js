import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cumulativeArrivals, pairTravelMinutes } from "../../src/domain/leg-interpreter.js";
import { nextDepartureIso, departureForSample } from "../../src/adapters/google-routes.js";

const legs = [
  { fromIndex: 0, toIndex: 1, distanceKm: 30, windows: { offPeak: { durationMin: 20, staticDurationMin: 18 } } },
  { fromIndex: 1, toIndex: 2, distanceKm: 10, windows: { offPeak: { durationMin: 10, staticDurationMin: 9 } } },
  { fromIndex: 2, toIndex: 3, distanceKm: 40, windows: { offPeak: { durationMin: 30, staticDurationMin: 28 } } },
];

describe("cumulativeArrivals", () => {
  test("applies per-leg factor to static only and dwell at intermediate stops", () => {
    const dwell = [60, 60, 60, 60];
    const r = cumulativeArrivals(legs, "offPeak", [1, 1, 1], dwell);
    assert.deepEqual(r.legMinutes, [20, 10, 30]);
    assert.deepEqual(r.arrivalOffsetsMin, [0, 20, 31, 62]);
  });
  test("per-leg factors scale static portion only", () => {
    const r = cumulativeArrivals(legs, "offPeak", [1.2, 1, 1], [0, 0, 0, 0]);
    assert.equal(r.legMinutes[0], 23.6);
    assert.equal(r.legMinutes[1], 10);
  });
});

describe("pairTravelMinutes", () => {
  test("arrival-to-arrival for all i<j", () => {
    const m = pairTravelMinutes([0, 20, 31, 62]);
    assert.equal(m.size, 6);
    assert.equal(m.get("0->3"), 62);
    assert.equal(m.get("1->2"), 11);
  });
});

describe("Google departure times", () => {
  test("nextDepartureIso lands on the requested weekday, strictly in the future, at London local time", () => {
    const now = new Date("2026-09-14T12:00:00Z"); // a Monday, BST
    const iso = nextDepartureIso("07:30", 2, { now }); // next Tuesday
    const d = new Date(iso);
    assert.ok(d > now);
    assert.equal(d.getUTCDay(), 2);
    assert.equal(iso, "2026-09-15T06:30:00.000Z"); // 07:30 BST = 06:30 UTC
  });
  test("winter dates use GMT", () => {
    const iso = nextDepartureIso("07:30", 2, { now: new Date("2026-12-14T12:00:00Z") });
    assert.equal(iso, "2026-12-15T07:30:00.000Z");
  });
  test("nextDepartureIso anchors to the first matching weekday on or after launchDate", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    const iso = nextDepartureIso("13:30", 2, { now, launchDate: "2026-11-25" });
    assert.equal(iso, "2026-12-01T13:30:00.000Z"); // first Tuesday on/after 25 Nov 2026
  });
  test("departureForSample maps band ids to weekdays", () => {
    const tw = { weekdayBands: [{ id: "peak2", kind: "peak", start: "16:00", end: "19:00", apex: "16:30" }] };
    assert.deepEqual(departureForSample("peak2", tw), { hhmm: "16:30", weekday: 2 });
    assert.equal(departureForSample("weekend", { ...tw, weekendDeparture: "11:00" }).weekday, 6);
    assert.throws(() => departureForSample("night", tw));
  });
  test("departureForSample uses per-direction weekendDeparture", () => {
    const tw = {
      outbound: { weekdayBands: [{ id: "peak1", kind: "peak", start: "07:00", end: "10:00", apex: "07:30" }], weekendDeparture: "12:00" },
      return: { weekdayBands: [{ id: "peak1", kind: "peak", start: "09:00", end: "12:00", apex: "09:45" }], weekendDeparture: "14:00" },
    };
    assert.deepEqual(departureForSample("weekend", tw, "outbound"), { hhmm: "12:00", weekday: 6 });
    assert.deepEqual(departureForSample("weekend", tw, "return"), { hhmm: "14:00", weekday: 6 });
  });
});
