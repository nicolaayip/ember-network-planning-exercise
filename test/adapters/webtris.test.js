/** @format */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  profile,
  detectBands,
  detectWeekendBusyHour,
  averageShares,
  hourlyPercent,
  quarterHourPercent,
  sitesNear,
  directionOf,
} from "../../src/adapters/webtris.js";

/** Synthetic rows: `days` dates x 96 intervals with a volume function of interval index. */
function rows(dates, volumeAt) {
  const out = [];
  for (const date of dates) {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (let i = 0; i < 96; i++) {
      const minutesEnding = i * 15 + 15;
      out.push({
        date,
        timeEnding: "",
        minutesEnding,
        weekday: wd,
        totalVolume: volumeAt(i, date),
      });
    }
  }
  return out;
}
const weekdays = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]; // Mon–Fri
const weekend = ["2026-06-06", "2026-06-07"];

// Commuter shape: peaks at 08:00 (i=32) and 17:00 (i=68), low overnight.
const commuter = (i) =>
  100 +
  400 * Math.exp(-((i - 32) ** 2) / 20) +
  350 * Math.exp(-((i - 68) ** 2) / 20) +
  (i > 24 && i < 80 ? 150 : 0);

describe("profile", () => {
  test("normalises to shares summing to 1 and reports coverage", () => {
    const p = profile(rows([...weekdays, ...weekend], commuter), [1, 2, 3, 4, 5]);
    assert.equal(p.daysUsed, 5);
    assert.equal(p.coverage, 1);
    assert.ok(Math.abs(p.shares.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.equal(p.means.length, 96);
  });
  test("drops days with too many nulls and reports reduced coverage", () => {
    const r = rows(weekdays, (i, date) =>
      date === "2026-06-03" && i < 20 ? null : commuter(i),
    );
    const p = profile(r, [1, 2, 3, 4, 5]);
    assert.equal(p.daysUsed, 4);
    assert.equal(p.coverage, 0.8);
  });
  test("weekend selection ignores weekdays", () => {
    const p = profile(rows([...weekdays, ...weekend], commuter), [0, 6]);
    assert.equal(p.daysUsed, 2);
  });
});

describe("detectBands", () => {
  test("finds two peak bands and a valley on a commuter profile", () => {
    const p = profile(rows(weekdays, commuter), [1, 2, 3, 4, 5]);
    const k = detectBands(p.shares);
    const peaks = k.bands.filter((b) => b.kind === "peak");
    const valleys = k.bands.filter((b) => b.kind === "valley");
    assert.equal(peaks.length, 2);
    assert.equal(valleys.length, 1);
    assert.equal(peaks[0].apex, "08:00");
    assert.equal(peaks[1].apex, "17:00");
    assert.ok(peaks[0].start < peaks[0].end);
    assert.ok(valleys[0].start < valleys[0].end);
    assert.equal(k.profileKind, "dual_peak");
  });
  test("a flat plateau profile yields a single peak band", () => {
    const flat = (i) => (i >= 28 && i < 72 ? 500 : 50);
    const k = detectBands(profile(rows(weekdays, flat), [1, 2, 3, 4, 5]).shares);
    assert.equal(k.bands.filter((b) => b.kind === "peak").length, 1);
    assert.ok(k.profileKind === "plateau" || k.profileKind === "single_peak");
  });
  test("peak band edges follow 80% flank threshold on rise and fall", () => {
    const p = profile(rows(weekdays, commuter), [1, 2, 3, 4, 5]);
    const k = detectBands(p.shares);
    const am = k.bands.find((b) => b.kind === "peak" && b.apex === "08:00");
    assert.ok(am);
    assert.ok(
      am.start >= "06:30",
      `AM peak should not start at search floor, got ${am.start}`,
    );
    assert.ok(am.end <= "10:30", `AM peak should end before lunch trough, got ${am.end}`);
    assert.ok(am.start < am.apex);
    assert.ok(am.end > am.apex);
  });
  test("merges a morning shoulder into a dominant afternoon plateau", () => {
    // Rising day profile with a minor pre-noon bump — trough between bumps is shallow.
    const shoulderPlateau = (i) => {
      if (i < 20) return 50;
      const base = 100 + (i - 20) * 8;
      const shoulder = 30 * Math.exp(-((i - 35) ** 2) / 15);
      const afternoon = 200 * Math.exp(-((i - 56) ** 2) / 80);
      return base + shoulder + afternoon;
    };
    const k = detectBands(
      profile(rows(weekdays, shoulderPlateau), [1, 2, 3, 4, 5]).shares,
    );
    const peaks = k.bands.filter((b) => b.kind === "peak");
    assert.equal(peaks.length, 1);
    assert.equal(k.bands.filter((b) => b.kind === "valley").length, 0);
    assert.ok(peaks[0].apex >= "13:00" && peaks[0].apex <= "15:00");
  });
});

describe("detectWeekendBusyHour", () => {
  test("finds a weekend peak band with 60% flank edges in the daytime search window", () => {
    const leisure = (i) => 100 + 700 * Math.exp(-((i - 44) ** 2) / 8);
    const p = profile(rows(weekend, leisure), [0, 6]);
    const b = detectWeekendBusyHour(p.shares);
    assert.equal(b.apex, "11:00");
    assert.equal(b.busyHourStart, "11:00");
    assert.ok(b.start);
    assert.ok(b.end);
    assert.ok(b.start < b.apex);
    assert.ok(b.end > b.apex);
    assert.ok(b.pctOfDay > 5);
  });
});

describe("helpers", () => {
  test("quarterHourPercent has 96 values summing to ~100", () => {
    const p = profile(rows(weekdays, commuter), [1, 2, 3, 4, 5]);
    const q = quarterHourPercent(p.shares);
    assert.equal(q.length, 96);
    assert.ok(Math.abs(q.reduce((a, b) => a + b, 0) - 100) < 0.05);
  });
  test("averageShares equal-weights profiles; hourlyPercent sums to ~100", () => {
    const a = profile(rows(weekdays, commuter), [1, 2, 3, 4, 5]);
    const b = profile(
      rows(weekdays, (i) => 1000),
      [1, 2, 3, 4, 5],
    );
    const avg = averageShares([a, b]);
    assert.ok(Math.abs(avg.reduce((x, y) => x + y, 0) - 1) < 1e-9);
    const h = hourlyPercent(avg);
    assert.equal(h.length, 24);
    assert.ok(Math.abs(h.reduce((x, y) => x + y, 0) - 100) < 0.5);
  });
  test("directionOf parses bound words and abbreviations", () => {
    assert.equal(directionOf("TMU Site on link A1 northbound between"), "northbound");
    assert.equal(directionOf("A1 SB J2"), "southbound");
    assert.equal(directionOf("no direction here"), null);
  });
  test("sitesNear filters by road regex and radius, nearest point first", () => {
    const sites = [
      {
        id: 1,
        name: "TMU on A1 northbound",
        description: "",
        lat: 55.0,
        lng: -1.7,
        status: "Active",
      },
      {
        id: 2,
        name: "TMU on A19 southbound",
        description: "",
        lat: 55.0,
        lng: -1.7,
        status: "Active",
      },
      {
        id: 3,
        name: "TMU on A1 southbound",
        description: "",
        lat: 56.0,
        lng: -1.7,
        status: "Active",
      },
    ];
    const near = sitesNear(sites, [{ lat: 55.001, lng: -1.7 }], 500);
    assert.deepEqual(
      near.map((s) => s.id),
      [1],
    );
    assert.equal(near[0].direction, "northbound");
    assert.ok(near[0].distanceM < 200);
  });
});
