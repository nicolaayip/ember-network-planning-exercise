import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildStopMatcher, matchJourney, sharesVector, journeyLinks, pairKey, flattenJourneys, serviceLabel,
  chainJourneys, dedupeJourneys,
} from "../../src/domain/link-flattening.js";

// Our direction: A → B → C → D (route indices 0..3).
const ROUTE = ["A", "B", "C", "D"];
const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const stop = (atco, dep, arr = dep) => ({ atco, depMin: hm(dep), arrMin: hm(arr) });
const journey = (over) => ({
  operatorNoc: "OP", operatorName: "Op Co", lineName: "X1", direction: "outbound", journeyCode: "vj1", source: "f.xml",
  departureMin: over.stops[0].depMin, ...over,
});

describe("buildStopMatcher / matchJourney", () => {
  test("exact ATCO match wins; alias table gives a tolerance match; unknown stops are undefined", () => {
    const m = buildStopMatcher(ROUTE, { B2: 1 });
    assert.deepEqual(m.indexOf("B"), { index: 1, viaTolerance: false });
    assert.deepEqual(m.indexOf("B2"), { index: 1, viaTolerance: true });
    assert.equal(m.indexOf("Z"), undefined);
    assert.equal(m.size, 4);
  });

  test("matches are monotonic in route order: a journey running D→C→B→A yields only its first hit", () => {
    const m = buildStopMatcher(ROUTE);
    const j = [stop("D", "07:00"), stop("C", "07:10"), stop("B", "07:20"), stop("A", "07:30")];
    const matches = matchJourney(j, m);
    assert.deepEqual(matches.map((x) => x.routeIndex), [3]);
    assert.equal(sharesVector(matches), false);
  });

  test("intermediate competitor-only stops are ignored; route indices and depMin are kept", () => {
    const m = buildStopMatcher(ROUTE);
    const j = [stop("A", "07:00"), stop("x1", "07:05"), stop("B", "07:10"), stop("x2", "07:15"), stop("D", "07:30")];
    const matches = matchJourney(j, m);
    assert.deepEqual(matches.map((x) => [x.routeIndex, x.journeyIndex, x.depMin]), [[0, 0, 420], [1, 2, 430], [3, 4, 450]]);
  });
});

describe("sharesVector (§4.2 OD-pair rule)", () => {
  test("A and C only serves the A→C OD pair; single stop does not; any two in order does", () => {
    const m = buildStopMatcher(ROUTE);
    assert.equal(sharesVector(matchJourney([stop("A", "07:00"), stop("C", "07:20")], m)), true);
    assert.equal(sharesVector(matchJourney([stop("A", "07:00")], m)), false);
    assert.equal(sharesVector(matchJourney([stop("A", "07:00"), stop("B", "07:20")], m)), true);
    assert.equal(sharesVector(matchJourney([stop("B", "07:00"), stop("C", "07:20"), stop("D", "07:40")], m)), true);
  });
});

describe("journeyLinks (§4.3)", () => {
  test("three matched stops produce 3 directed links, each stamped with the ORIGIN departure time", () => {
    const m = buildStopMatcher(ROUTE);
    const links = journeyLinks(matchJourney([stop("A", "07:00"), stop("B", "07:10"), stop("D", "07:30")], m));
    assert.deepEqual(links, [
      { originIndex: 0, destIndex: 1, depMin: 420 },
      { originIndex: 0, destIndex: 3, depMin: 420 },
      { originIndex: 1, destIndex: 3, depMin: 430 },
    ]);
    assert.equal(pairKey(0, 3), "0->3");
  });
});

describe("flattenJourneys", () => {
  test("four retained journeys; A→C express counts; single-stop touch dropped", () => {
    const journeys = [
      journey({ journeyCode: "j1", stops: [stop("A", "07:00"), stop("B", "07:10"), stop("C", "07:20"), stop("D", "07:30")] }),
      journey({ journeyCode: "j2", stops: [stop("A", "09:00"), stop("B2", "09:12"), stop("C", "09:25")] }), // B via 50 m alias
      journey({ journeyCode: "j3", stops: [stop("A", "10:00"), stop("C", "10:20")] }), // A→C OD pair
      journey({ journeyCode: "j4", operatorNoc: "OT", operatorName: "Other", lineName: "9", stops: [stop("C", "11:00"), stop("D", "11:15")] }),
      journey({ journeyCode: "j5", stops: [stop("B", "12:00")] }), // single match → dropped
    ];
    const r = flattenJourneys(journeys, ROUTE, { aliases: { B2: 1 } });

    assert.equal(r.retained.length, 4);
    assert.equal(r.dropped, 1);
    assert.equal(r.toleranceMatches, 1);

    // A→B: j1 07:00 and j2 09:00; C→D: j1 07:20 and j4 11:00; A→D: j1 only; A→C: j3 10:00.
    assert.deepEqual(r.timelines.get("0->1").map((t) => t.depMin), [hm("07:00"), hm("09:00")]);
    assert.deepEqual(r.timelines.get("2->3").map((t) => [t.depMin, t.service]), [[hm("07:20"), "Op Co X1"], [hm("11:00"), "Other 9"]]);
    assert.deepEqual(r.timelines.get("0->3").map((t) => t.depMin), [hm("07:00")]);
    assert.deepEqual(r.timelines.get("0->2").map((t) => t.depMin), [hm("07:00"), hm("09:00"), hm("10:00")]);
    assert.equal(r.timelines.get("1->0"), undefined);

    // Departures per route stop that go on to a later route stop: A 3 (j1, j2, j3), B 2, C 2 (j1, j4), D 0.
    assert.deepEqual(r.stopDepartures, [3, 2, 2, 0]);

    const svc = [...r.services.values()].map((s) => [s.operator, s.line, s.direction, s.journeys, [...s.stopIndices].sort()]);
    assert.deepEqual(svc, [
      ["Op Co", "X1", "outbound", 3, [0, 1, 2, 3]],
      ["Other", "9", "outbound", 1, [2, 3]],
    ]);
  });

  test("timelines are sorted chronologically regardless of input order", () => {
    const journeys = [
      journey({ stops: [stop("A", "09:00"), stop("B", "09:10")] }),
      journey({ stops: [stop("A", "07:00"), stop("B", "07:10")] }),
    ];
    assert.deepEqual(flattenJourneys(journeys, ROUTE).timelines.get("0->1").map((t) => t.depMin), [420, 540]);
  });

  test("serviceLabel is 'Operator LineName', falling back to the NOC", () => {
    assert.equal(serviceLabel({ operatorName: "Borders Buses", lineName: "253" }), "Borders Buses 253");
    assert.equal(serviceLabel({ operatorNoc: "PERY", lineName: "253" }), "PERY 253");
  });
});

describe("dedupeJourneys", () => {
  test("identical operator/line/departure/stop sequence counts as a duplicate; a different time does not", () => {
    const a = journey({ stops: [stop("A", "07:00"), stop("B", "07:10")] });
    const b = { ...a, source: "another-file.xml" };
    const c = journey({ stops: [stop("A", "07:00"), stop("B", "07:11")] });
    const r = dedupeJourneys([a, b, c]);
    assert.equal(r.journeys.length, 2);
    assert.equal(r.duplicates, 1);
  });
});

describe("chainJourneys (sectional registrations → through journeys)", () => {
  // A straight line of stops running north (lat increasing); S is a bus station with two kerbs S1/S2 60 m apart.
  const coords = {
    A: { lat: 55.00, lng: -1.6 }, B: { lat: 55.05, lng: -1.6 },
    S1: { lat: 55.10, lng: -1.6 }, S2: { lat: 55.1005, lng: -1.6 }, // ≈ 56 m apart
    C: { lat: 55.15, lng: -1.6 }, D: { lat: 55.20, lng: -1.6 },
  };
  const coordsOf = (atco) => coords[atco];
  const leg = (code, stops) => journey({ journeyCode: code, stops });

  test("leg ending at S1 chained with leg leaving S2 (56 m, 5 min later, same heading): stops merged, one chain", () => {
    const legs = [
      leg("north1", [stop("A", "07:00"), stop("B", "07:20"), stop("S1", "07:40")]),
      leg("north2", [stop("S2", "07:45"), stop("C", "08:05"), stop("D", "08:25")]),
    ];
    const r = chainJourneys(legs, { coordsOf, maxWaitMin: 20, junctionRadiusM: 150, maxTurnDeg: 90 });
    assert.equal(r.chains, 1);
    assert.equal(r.segmentsJoined, 1);
    assert.equal(r.journeys.length, 1);
    assert.deepEqual(r.journeys[0].stops.map((s) => s.atco), ["A", "B", "S1", "S2", "C", "D"]);
    assert.deepEqual(r.journeys[0].segments, ["f.xml#north1", "f.xml#north2"]);
  });

  test("same junction stop is merged into one entry carrying the onward departure time", () => {
    const legs = [
      leg("n1", [stop("A", "07:00"), stop("S1", "07:40")]),
      leg("n2", [stop("S1", "07:47", "07:47"), stop("C", "08:05")]),
    ];
    const r = chainJourneys(legs, { coordsOf });
    assert.deepEqual(r.journeys[0].stops.map((s) => [s.atco, s.depMin]), [["A", 420], ["S1", 467], ["C", 485]]);
  });

  test("the return working (heading back south) leaving the same bus station is NOT chained", () => {
    const legs = [
      leg("north", [stop("A", "07:00"), stop("S1", "07:40")]),
      leg("south", [stop("S2", "07:45"), stop("B", "08:05"), stop("A", "08:25")]),
    ];
    const r = chainJourneys(legs, { coordsOf });
    assert.equal(r.chains, 0);
    assert.equal(r.journeys.length, 2);
  });

  test("no chain when the wait exceeds maxWaitMin, the operator/line differ, or the junction is too far", () => {
    const tail = leg("n1", [stop("A", "07:00"), stop("S1", "07:40")]);
    assert.equal(chainJourneys([tail, leg("late", [stop("S1", "08:10"), stop("C", "08:30")])], { coordsOf, maxWaitMin: 20 }).chains, 0);
    assert.equal(chainJourneys([tail, { ...leg("other", [stop("S1", "07:45"), stop("C", "08:05")]), lineName: "X2" }], { coordsOf }).chains, 0);
    assert.equal(chainJourneys([tail, leg("far", [stop("C", "07:45"), stop("D", "08:05")])], { coordsOf }).chains, 0); // S1→C ≈ 5.6 km
  });

  test("three sections chain into one through journey; a stand-alone journey is passed through untouched", () => {
    const legs = [
      leg("s1", [stop("A", "07:00"), stop("B", "07:20")]),
      leg("s2", [stop("B", "07:22"), stop("S1", "07:40")]),
      leg("s3", [stop("S1", "07:44"), stop("C", "08:05"), stop("D", "08:25")]),
      leg("solo", [stop("A", "12:00"), stop("B", "12:20")]),
    ];
    const r = chainJourneys(legs, { coordsOf });
    assert.equal(r.chains, 1);
    assert.equal(r.segmentsJoined, 2);
    assert.equal(r.journeys.length, 2);
    assert.deepEqual(r.journeys[0].stops.map((s) => s.atco), ["A", "B", "S1", "C", "D"]);
    assert.deepEqual(r.journeys[1].stops.map((s) => s.atco), ["A", "B"]);
  });
});
