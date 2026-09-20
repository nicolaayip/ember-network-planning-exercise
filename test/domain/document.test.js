import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildEmptyDocument,
  buildDirectionalPairs,
  buildDirection,
  layoverStopId,
  legDepartureDwellSeconds,
  normaliseStop,
  normaliseColumns,
  allPairs,
  pairId,
  schedulingDwellSeconds,
  slugify,
} from "../../src/domain/document.js";
import { config } from "../../src/config.js";
import { fallbackTemporalWindows } from "../../src/domain/temporal-windows.js";
import { validateDocument } from "../../src/lib/validate.js";

const engine = config.engine;

const stops = (n, prefix = "S") => Array.from({ length: n }, (_, i) => ({ naptanId: `${prefix}${i}` }));
const input = (nOut, nRet = nOut, extra = {}) => ({
  routeName: "Test Route",
  directions: { outbound: { stops: stops(nOut, "O") }, return: { stops: stops(nRet, "R") } },
  ...extra,
});

describe("buildEmptyDocument", () => {
  test("produces a schema-valid document with all metrics zeroed", () => {
    const doc = buildEmptyDocument(input(3), engine);
    const { valid, errors } = validateDocument(doc);
    assert.equal(valid, true, JSON.stringify(errors, null, 2));
    for (const { pair } of allPairs(doc)) {
      assert.equal(pair.simulatedTravelTimeMinutes, 0);
      assert.equal(pair.demandVector.offPeakWeekday.calculatedWeekdayGravityPotential, 0);
      assert.deepEqual(pair.supplyVector, { detectedOverlappingLines: [], calculatedHeadwayGaps: [], competitorDepartures: [] });
    }
  });

  test("always-served terminals keep the default dwell buffer; only depot is zeroed at normalise", () => {
    const doc = buildEmptyDocument(
      {
        routeName: "R",
        directions: {
          outbound: { stops: [{ naptanId: "T0", alwaysServed: true }, { naptanId: "M1" }, { naptanId: "T2", alwaysServed: true }] },
          return: { stops: [{ naptanId: "T0", alwaysServed: true }, { naptanId: "M1" }, { naptanId: "T2", alwaysServed: true }] },
        },
      },
      engine
    );
    assert.equal(doc.directions.outbound.orderedStops[0].dwellTimeBufferSeconds, 75);
    assert.equal(doc.directions.outbound.orderedStops[1].dwellTimeBufferSeconds, 75);
    assert.equal(doc.directions.outbound.orderedStops[2].dwellTimeBufferSeconds, 75);
  });

  test("depot: first of outbound / last of return, routed but without pairs, dwell or NaPTAN lookup", () => {
    const depot = { naptanId: "DEPOT:x", role: "depot", stopName: "Depot", coordinates: { lat: 54.96, lng: -1.66 }, dwellTimeBufferSeconds: 90 };
    const doc = buildEmptyDocument(
      { routeName: "R", directions: { outbound: { stops: [depot, ...stops(3, "O")] }, return: { stops: [...stops(3, "R"), depot] } } },
      engine
    );
    assert.equal(validateDocument(doc).valid, true, JSON.stringify(validateDocument(doc).errors));
    assert.equal(doc.directions.outbound.orderedStops[0].role, "depot");
    assert.equal(doc.directions.outbound.orderedStops[0].dwellTimeBufferSeconds, 0);
    assert.equal(doc.directions.return.orderedStops.at(-1).role, "depot");
    assert.equal(doc.directions.outbound.orderedStops[1].role, undefined);
    // 3 passenger stops → 3 pairs; none involve the depot
    assert.equal(doc.directions.outbound.directionalODPairs.length, 3);
    assert.ok(doc.directions.outbound.directionalODPairs.every((p) => !p.pairId.includes("DEPOT")));
  });

  test("depot must carry coordinates and sit at the route end nearest the depot", () => {
    const depot = { naptanId: "DEPOT:x", role: "depot", coordinates: { lat: 54.96, lng: -1.66 } };
    assert.throws(() => normaliseStop({ naptanId: "DEPOT:x", role: "depot" }, 0, engine), /must carry coordinates/);
    assert.throws(() => normaliseStop({ naptanId: "S", role: "garage", coordinates: { lat: 1, lng: 1 } }, 0, engine), /role must be one of/);
    assert.throws(() => buildDirection({ stops: [...stops(2, "O"), depot] }, engine, "outbound"), /must be the first point/);
    assert.throws(() => buildDirection({ stops: [depot, ...stops(2, "R")] }, engine, "return"), /must be the last point/);
    assert.throws(() => buildDirection({ stops: [depot, ...stops(1, "O")] }, engine, "outbound"), /at least 2 passenger stops/);
  });

  test("builds two independent directions with n(n-1)/2 pairs each", () => {
    const doc = buildEmptyDocument(input(4, 3), engine);
    assert.equal(doc.directions.outbound.orderedStops.length, 4);
    assert.equal(doc.directions.return.orderedStops.length, 3);
    assert.equal(doc.directions.outbound.directionalODPairs.length, 6);
    assert.equal(doc.directions.return.directionalODPairs.length, 3);
    assert.deepEqual(
      doc.directions.return.directionalODPairs.map((p) => p.pairId),
      ["R0->R1", "R0->R2", "R1->R2"]
    );
    assert.equal([...allPairs(doc)].length, 9);
  });

  test("mode is propose without columns and evaluate with them", () => {
    assert.equal(buildEmptyDocument(input(2), engine).mode, "propose");
    const doc = buildEmptyDocument(
      input(2, 2, { timetableColumns: [{ outboundDeparture: "07:00", returnDeparture: "10:15" }] }),
      engine
    );
    assert.equal(doc.mode, "evaluate");
    assert.deepEqual(doc.timetableColumns, [
      { columnId: "C01", outboundDeparture: "07:00", returnDeparture: "10:15" },
    ]);
    assert.equal(validateDocument(doc).valid, true);
  });

  test("uses fallback temporal windows (tagged as such) and default dwell buffer", () => {
    const doc = buildEmptyDocument(input(2), engine);
    assert.deepEqual(doc.estimatedTemporalWindows, fallbackTemporalWindows(engine.fallbackTemporalWindows));
    assert.equal(doc.directions.outbound.orderedStops[0].dwellTimeBufferSeconds, 75);
  });

  test("respects per-stop overrides and direction labels", () => {
    const doc = buildEmptyDocument(
      {
        routeName: "R",
        directions: {
          outbound: {
            label: "A → B",
            stops: [
              { naptanId: "A", alwaysServed: true, dwellTimeBufferSeconds: 90, stopName: "Alpha", localityName: "Town", coordinates: { lat: 55.9, lng: -3.2 } },
              { naptanId: "B", isSingleCarriageway: true, hasBusLane: false },
            ],
          },
          return: { stops: stops(2, "R") },
        },
      },
      engine
    );
    const [a, b] = doc.directions.outbound.orderedStops;
    assert.equal(doc.directions.outbound.label, "A → B");
    assert.equal(a.alwaysServed, true);
    assert.equal(a.dwellTimeBufferSeconds, 90, "explicit dwell override is kept on always-served terminals");
    assert.equal(a.stopName, "Alpha");
    assert.equal(a.localityName, "Town");
    assert.deepEqual(a.coordinates, { lat: 55.9, lng: -3.2 });
    assert.equal("isSingleCarriageway" in a, false, "reserved flag only present when supplied");
    assert.equal(b.isSingleCarriageway, true);
    assert.equal(b.hasBusLane, false);
    assert.equal(b.stopName, "B");
    assert.equal("localityName" in b, false);
    assert.equal("alwaysServed" in b, false);
  });

  test("derives routeId from routeName when not supplied", () => {
    const doc = buildEmptyDocument({ ...input(2), routeName: "Edinburgh – Glasgow (X1)" }, engine);
    assert.equal(doc.routeId, "edinburgh-glasgow-x1");
    assert.equal(buildEmptyDocument({ ...input(2), routeId: "my-id" }, engine).routeId, "my-id");
  });

  test("rejects invalid input", () => {
    assert.throws(() => buildEmptyDocument({ ...input(2), routeName: "" }, engine), /routeName/);
    assert.throws(() => buildEmptyDocument({ routeName: "R" }, engine), /directions/);
    assert.throws(() => buildEmptyDocument(input(1), engine), /outbound\.stops.*at least 2/);
    assert.throws(() => buildEmptyDocument(input(2, 1), engine), /return\.stops.*at least 2/);
    assert.throws(
      () => buildEmptyDocument({ routeName: "R", directions: { outbound: { stops: [{ naptanId: "A" }, { naptanId: "A" }] }, return: { stops: stops(2) } } }, engine),
      /outbound.*duplicate/
    );
    assert.throws(
      () => buildEmptyDocument({ routeName: "R", directions: { outbound: { stops: stops(2) }, return: { stops: [{ naptanId: "A" }, {}] } } }, engine),
      /return\.stops\[1\]/
    );
    assert.throws(
      () => buildEmptyDocument(input(2, 2, { timetableColumns: [{ outboundDeparture: "7:00", returnDeparture: "10:15" }] }), engine),
      /timetableColumns\[0\]\.outboundDeparture/
    );
  });
});

describe("schedulingDwellSeconds", () => {
  test("passenger dwell at all calling points except depot and return layover departure", () => {
    const doc = buildEmptyDocument(
      {
        routeName: "R",
        directions: {
          outbound: { stops: [{ naptanId: "DEPOT:x", role: "depot", coordinates: { lat: 1, lng: 1 } }, { naptanId: "A", alwaysServed: true }, { naptanId: "M" }, { naptanId: "B", alwaysServed: true }] },
          return: { stops: [{ naptanId: "B", alwaysServed: true }, { naptanId: "M" }, { naptanId: "A", alwaysServed: true }, { naptanId: "DEPOT:x", role: "depot", coordinates: { lat: 1, lng: 1 } }] },
        },
      },
      engine
    );
    const out = doc.directions.outbound;
    const ret = doc.directions.return;
    const outLayover = layoverStopId(out, "outbound");
    const retLayover = layoverStopId(ret, "return");
    assert.equal(outLayover, null);
    assert.equal(retLayover, "B");
    const outA = out.orderedStops[1];
    const retB = ret.orderedStops[0];
    assert.equal(schedulingDwellSeconds(out.orderedStops[0], { directionName: "outbound", layoverStopId: outLayover }), 0, "depot");
    assert.equal(schedulingDwellSeconds(outA, { directionName: "outbound", layoverStopId: outLayover }), 75, "first outbound terminal");
    assert.equal(schedulingDwellSeconds(retB, { directionName: "return", layoverStopId: retLayover }), 0, "return layover departure");
    assert.equal(schedulingDwellSeconds(ret.orderedStops[2], { directionName: "return", layoverStopId: retLayover }), 75, "home terminal before dead leg");
    assert.equal(legDepartureDwellSeconds({ deadLeg: true }, outA, { directionName: "outbound", layoverStopId: outLayover }), 0, "dead leg");
    assert.equal(legDepartureDwellSeconds({}, outA, { directionName: "outbound", layoverStopId: outLayover }), 75, "passenger leg");
  });
});

describe("helpers", () => {
  test("pairId is deterministic", () => {
    assert.equal(pairId("A", "B"), "A->B");
  });
  test("slugify", () => {
    assert.equal(slugify("  Aberdeen → Inverness!  "), "aberdeen-inverness");
    assert.equal(slugify("***"), "route");
  });
  test("normaliseStop defaults missing coordinates to 0,0 pending Step 1 lookup", () => {
    const s = normaliseStop({ naptanId: "X" }, 4, engine);
    assert.equal(s.sequenceOrder, 4);
    assert.deepEqual(s.coordinates, { lat: 0, lng: 0 });
    assert.equal("isSingleCarriageway" in s, false);
  });
  test("buildDirectionalPairs on 2 stops yields a single pair", () => {
    const pairs = buildDirectionalPairs([{ naptanId: "A" }, { naptanId: "B" }]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].originStopId, "A");
    assert.equal(pairs[0].destinationStopId, "B");
  });
  test("buildDirection carries label and validates", () => {
    const d = buildDirection({ label: "X → Y", stops: stops(3) }, engine, "outbound");
    assert.equal(d.label, "X → Y");
    assert.equal(d.directionalODPairs.length, 3);
  });
  test("normaliseColumns preserves explicit ids and assigns sequential ones", () => {
    assert.deepEqual(normaliseColumns(undefined), []);
    const cols = normaliseColumns([
      { columnId: "AM1", outboundDeparture: "06:30", returnDeparture: "09:45" },
      { outboundDeparture: "08:30", returnDeparture: "11:45" },
    ]);
    assert.deepEqual(cols.map((c) => c.columnId), ["AM1", "C02"]);
    assert.throws(() => normaliseColumns("nope"), /array/);
  });
});
