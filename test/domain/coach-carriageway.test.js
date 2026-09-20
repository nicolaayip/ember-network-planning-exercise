import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOsmWay,
  coachFactorForKind,
  coachLegMin,
  coachStaticMin,
  dominantKind,
  sumCoachStaticMin,
  COACH_FACTORS,
} from "../../src/domain/coach-carriageway.js";

describe("classifyOsmWay", () => {
  test("dual_carriageway yes", () => {
    assert.equal(classifyOsmWay({ dual_carriageway: "yes", highway: "trunk" }), "dual");
  });
  test("dual_carriageway no", () => {
    assert.equal(classifyOsmWay({ dual_carriageway: "no", ref: "A1" }), "single");
  });
  test("motorway", () => {
    assert.equal(classifyOsmWay({ highway: "motorway" }), "dual");
  });
  test("untagged A1 60 mph → single", () => {
    assert.equal(classifyOsmWay({ highway: "trunk", ref: "A1", maxspeed: "60 mph" }), "single");
  });
});

describe("dominantKind", () => {
  test("no trunk ways → urban", () => {
    assert.equal(dominantKind([{ tags: { highway: "primary" } }]), "urban");
  });
  test("plurality dual", () => {
    const els = [
      { tags: { highway: "trunk", ref: "A1", dual_carriageway: "yes" } },
      { tags: { highway: "trunk", ref: "A1", dual_carriageway: "yes" } },
      { tags: { highway: "trunk", ref: "A1", dual_carriageway: "no" } },
    ];
    assert.equal(dominantKind(els), "dual");
  });
});

describe("coachLegMin", () => {
  test("free-flow: no congestion term", () => {
    assert.equal(coachLegMin({ durationMin: 30, staticDurationMin: 30 }, 1.2), 36);
  });
  test("peak: static scaled, congestion passthrough", () => {
    assert.equal(coachLegMin({ durationMin: 50, staticDurationMin: 30 }, 1.2), 36 + 20);
  });
  test("clamps negative congestion", () => {
    assert.equal(coachLegMin({ durationMin: 28, staticDurationMin: 30 }, 1.2), 36);
  });
});

describe("coachFactorForKind", () => {
  test("known kinds", () => {
    assert.equal(coachFactorForKind("urban"), COACH_FACTORS.urban);
    assert.equal(coachFactorForKind("single"), 1.2);
    assert.ok(Math.abs(coachFactorForKind("dual") - 70 / 60) < 0.001);
  });
});

describe("coachStaticMin", () => {
  test("static only", () => {
    assert.equal(coachStaticMin({ staticDurationMin: 25 }, 1.2), 30);
  });
});

describe("sumCoachStaticMin", () => {
  test("topology legs with windows", () => {
    const legs = [
      { windows: { valley1: { staticDurationMin: 10 } } },
      { windows: { valley1: { staticDurationMin: 20 } } },
    ];
    assert.equal(sumCoachStaticMin(legs, [1.2, 1], "valley1"), 32);
  });

  test("skip-stop legs with staticDurationMin", () => {
    const legs = [
      { staticDurationMin: 10, toIndex: 1 },
      { staticDurationMin: 15, toIndex: 2 },
    ];
    assert.equal(sumCoachStaticMin(legs, [1.2, 1], "valley1"), 27);
  });
});
