import test from "node:test";
import assert from "node:assert/strict";
import { fitFleetCap } from "../../src/domain/fleet-fit.js";

test("fitFleetCap returns all columns when cap is null", () => {
  const cols = [
    { columnId: "R01", marginalGain: 1 },
    { columnId: "R02", marginalGain: 0.5 },
  ];
  const r = fitFleetCap(cols, null, () => 2);
  assert.equal(r.columns.length, 2);
  assert.equal(r.dropped.length, 0);
  assert.equal(r.vehiclesRequired, 2);
});

test("fitFleetCap drops lowest-marginal columns until within cap", () => {
  const cols = [
    { columnId: "R01", marginalGain: 1.5 },
    { columnId: "R02", marginalGain: 0.01 },
    { columnId: "R03", marginalGain: 0.8 },
  ];
  const need = (set) => (set.length >= 3 ? 6 : set.length);
  const r = fitFleetCap(cols, 2, need);
  assert.deepEqual(
    r.columns.map((c) => c.columnId),
    ["R01", "R03"],
  );
  assert.deepEqual(r.dropped.map((c) => c.columnId), ["R02"]);
  assert.equal(r.vehiclesRequired, 2);
});
