import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathDetour, PATH_DETOUR_WARN } from "../../src/domain/pair-competitiveness.js";

describe("pathDetour", () => {
  test("shorter coach path → ratio < 1", () => {
    const r = pathDetour({ coachPathKm: 80, directCarKm: 100 });
    assert.equal(r.pathDetourRatio, 0.8);
    assert.equal(r.pathDetourWarning, false);
  });

  test("longer coach path → ratio > 1, warning when above threshold", () => {
    const r = pathDetour({ coachPathKm: 125, directCarKm: 100 });
    assert.equal(r.pathDetourRatio, 1.25);
    assert.equal(r.pathDetourWarning, r.pathDetourRatio > PATH_DETOUR_WARN);
  });

  test("null when direct km missing", () => {
    assert.equal(pathDetour({ coachPathKm: 10, directCarKm: 0 }), null);
  });
});
