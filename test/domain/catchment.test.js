import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as turf from "@turf/turf";
import { proportionalCatchment } from "../../src/domain/catchment.js";

// Small squares in degrees near 55°N; areas are compared as ratios so projection distortion cancels.
const square = (lng0, lat0, size) => turf.polygon([[[lng0, lat0], [lng0 + size, lat0], [lng0 + size, lat0 + size], [lng0, lat0 + size], [lng0, lat0]]]);
const zone = (code, pop, poly) => ({ code, name: code, country: "test", population: pop, geometry: poly.geometry });

describe("proportionalCatchment", () => {
  test("a zone fully inside contributes 100% of its population", () => {
    const iso = square(0, 55, 0.02);
    const z = zone("A", 1000, square(0.005, 55.005, 0.005));
    const c = proportionalCatchment(iso, [z]);
    assert.equal(c.zones.length, 1);
    assert.ok(c.zones[0].ratio > 0.999, `${c.zones[0].ratio}`);
    assert.equal(c.population, 1000);
  });

  test("a zone half inside contributes 50% — the 5% fix in action", () => {
    const iso = square(0, 55, 0.02);
    const half = zone("B", 2000, square(0.01, 55, 0.02)); // straddles the isochrone's east edge, half inside
    const c = proportionalCatchment(iso, [half]);
    assert.ok(Math.abs(c.zones[0].ratio - 0.5) < 0.01, `${c.zones[0].ratio}`);
    assert.ok(Math.abs(c.population - 1000) <= 20, `${c.population}`);
  });

  test("a zone 5% inside contributes 5%", () => {
    const iso = square(0, 55, 0.02);
    const big = zone("C", 10000, square(0.019, 55, 0.02)); // 0.001 of 0.02 width inside = 5%
    const c = proportionalCatchment(iso, [big]);
    assert.ok(Math.abs(c.zones[0].ratio - 0.05) < 0.005, `${c.zones[0].ratio}`);
    assert.ok(Math.abs(c.population - 500) <= 50, `${c.population}`);
  });

  test("non-overlapping zones are dropped; unpopulated zones are flagged and contribute 0", () => {
    const iso = square(0, 55, 0.02);
    const far = zone("D", 5000, square(1, 56, 0.02));
    const noPop = zone("E", null, square(0.005, 55.005, 0.005));
    const c = proportionalCatchment(iso, [far, noPop]);
    assert.equal(c.zones.length, 1);
    assert.deepEqual(c.unpopulatedZones, ["E"]);
    assert.equal(c.population, 0);
  });

  test("zones are sorted by allocated population, largest first", () => {
    const iso = square(0, 55, 0.02);
    const small = zone("S", 100, square(0.001, 55.001, 0.004));
    const large = zone("L", 900, square(0.01, 55.01, 0.004));
    const c = proportionalCatchment(iso, [small, large]);
    assert.deepEqual(c.zones.map((z) => z.code), ["L", "S"]);
    assert.ok(c.areaKm2 > 0);
  });
});
