import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { config } from "../../src/config.js";
import { validateDocument, assertValidDocument, SchemaValidationError, schema } from "../../src/lib/validate.js";
import { buildEmptyDocument } from "../../src/domain/document.js";

const engine = config.engine;
const valid = () =>
  buildEmptyDocument(
    {
      routeName: "R",
      directions: {
        outbound: { stops: [{ naptanId: "A" }, { naptanId: "B" }] },
        return: { stops: [{ naptanId: "B2" }, { naptanId: "A2" }] },
      },
      timetableColumns: [{ outboundDeparture: "07:00", returnDeparture: "10:15" }],
    },
    engine
  );

describe("schema", () => {
  test("loads the contract from .cursor/DATA_SCHEMA.json", () => {
    assert.equal(schema.title, "FlexibleRouteOptimizationDocument");
    assert.deepEqual(schema.required, ["routeId", "routeName", "mode", "directions", "timetableColumns"]);
  });
});

describe("validateDocument", () => {
  test("accepts a well-formed document", () => {
    assert.deepEqual(validateDocument(valid()), { valid: true, errors: [] });
  });

  test("rejects a missing direction", () => {
    const doc = valid();
    delete doc.directions.return;
    const r = validateDocument(doc);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "/directions" && e.message.includes("return")));
  });

  test("rejects a direction with fewer than 2 stops", () => {
    const doc = valid();
    doc.directions.outbound.orderedStops.pop();
    const r = validateDocument(doc);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "/directions/outbound/orderedStops"));
  });

  test("rejects an unknown mode", () => {
    const doc = valid();
    doc.mode = "guess";
    assert.equal(validateDocument(doc).valid, false);
  });

  test("rejects malformed temporal window and column time strings", () => {
    const doc = valid();
    doc.estimatedTemporalWindows.outbound.weekdayBands[0].apex = "7:30";
    let r = validateDocument(doc);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path.includes("/estimatedTemporalWindows/outbound/weekdayBands/0/apex")));

    const doc2 = valid();
    doc2.timetableColumns[0].returnDeparture = "25:99";
    r = validateDocument(doc2);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path === "/timetableColumns/0/returnDeparture"));
  });

  test("accepts service-day times past midnight and depot legs on columns", () => {
    const doc = valid();
    doc.timetableColumns[0] = { columnId: "C08", outboundDeparture: "21:15", returnDeparture: "25:22", depotDeparture: "21:00", depotArrival: "28:57" };
    doc.directions.outbound.orderedStops[1].proposedTimes = ["09:27", "23:27"];
    doc.daysOfOperation = "Mon - Sun";
    assert.deepEqual(validateDocument(doc), { valid: true, errors: [] });
  });

  test("rejects negative off-peak demand counts", () => {
    const doc = valid();
    doc.directions.outbound.directionalODPairs[0].demandVector.offPeakWeekday.proportionalRetainedPopulation = -1;
    assert.equal(validateDocument(doc).valid, false);
  });

  test("rejects a headway gap missing isMarketOpening", () => {
    const doc = valid();
    doc.directions.return.directionalODPairs[0].supplyVector.calculatedHeadwayGaps.push({
      gapStart: "09:10",
      gapEnd: "11:05",
      durationMinutes: 115,
    });
    const r = validateDocument(doc);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.message.includes("isMarketOpening")));
  });

  test("accepts optional column checks and per-window travel times", () => {
    const doc = valid();
    doc.timetableColumns[0].layoverMinutes = 50;
    doc.timetableColumns[0].columnScore = 412.5;
    doc.timetableColumns[0].checks = { layoverAtLeast45Min: true, continuousDrivingWithin4h30: true };
    doc.directions.outbound.directionalODPairs[0].simulatedTravelTimeBySample = { peak1: 190, valley1: 175 };
    assert.deepEqual(validateDocument(doc), { valid: true, errors: [] });
  });
});

describe("assertValidDocument", () => {
  test("returns the document when valid", () => {
    const doc = valid();
    assert.equal(assertValidDocument(doc), doc);
  });
  test("throws SchemaValidationError with collected errors when invalid", () => {
    const doc = valid();
    doc.mode = "guess";
    assert.throws(
      () => assertValidDocument(doc),
      (err) => err instanceof SchemaValidationError && err.errors.length >= 1 && /mode/.test(err.message)
    );
  });
});
