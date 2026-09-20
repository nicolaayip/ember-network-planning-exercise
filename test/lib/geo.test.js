import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bngToLngLat, haversineMetres, bboxOf } from "../../src/lib/geo.js";

describe("bngToLngLat", () => {
  test("Glasgow Buchanan Bus Station Stance 1 (NaPTAN 60903717, E 259218 N 665891)", () => {
    const { lng, lat } = bngToLngLat(259218, 665891);
    // Known position ≈ 55.8647 N, 4.2513 W; Helmert transform is good to ~2 m.
    assert.ok(Math.abs(lat - 55.8647) < 0.001, `lat ${lat}`);
    assert.ok(Math.abs(lng - -4.2513) < 0.001, `lng ${lng}`);
  });

  test("matches ONS-published centroid for LSOA E01000001 (City of London 001A)", () => {
    // ONS LSOA 2021 attributes: BNG_E 532250, BNG_N 181864, LAT 51.52022, LONG -0.09523
    const { lng, lat } = bngToLngLat(532250, 181864);
    assert.ok(Math.abs(lat - 51.52022) < 0.0001, `lat ${lat}`);
    assert.ok(Math.abs(lng - -0.09523) < 0.0001, `lng ${lng}`);
  });
});

describe("haversineMetres", () => {
  test("Edinburgh bus station to Glasgow Buchanan is ~66 km", () => {
    const d = haversineMetres({ lat: 55.95533, lng: -3.192065 }, { lat: 55.8647, lng: -4.2513 });
    assert.ok(d > 65_000 && d < 68_000, `${d}`);
  });
  test("zero distance for identical points", () => {
    assert.equal(haversineMetres({ lat: 1, lng: 1 }, { lat: 1, lng: 1 }), 0);
  });
});

describe("bboxOf", () => {
  test("wraps points and pads by metres", () => {
    const pts = [{ lat: 55, lng: -3 }, { lat: 56, lng: -4 }];
    assert.deepEqual(bboxOf(pts), [-4, 55, -3, 56]);
    const [w, s, e, n] = bboxOf(pts, 1000);
    assert.ok(w < -4 && s < 55 && e > -3 && n > 56);
    assert.ok(Math.abs(n - 56 - 1000 / 111_320) < 1e-9);
  });
});
