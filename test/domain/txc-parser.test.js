import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  arr, parseTxcXml, parseTxc, expandJourneys, expandPattern, parseDurationMinutes, parseTxcTime,
  parseOperatingProfile, operatesOn, dayOfWeek, periodCovers,
} from "../../src/domain/txc-parser.js";

const FIX = new URL("../../fixtures/txc/", import.meta.url);
const ARRIVA = new URL("bods-15763-arriva-x15-alnwick-berwick-monfri.xml", FIX);
const BORDERS = new URL("bods-21610-borders-253-optibus-trimmed.xml", FIX);
const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

describe("helpers", () => {
  test("arr() normalises xml2js one-or-many", () => {
    assert.deepEqual(arr(undefined), []);
    assert.deepEqual(arr({ a: 1 }), [{ a: 1 }]);
    assert.deepEqual(arr([1, 2]), [1, 2]);
  });

  test("ISO 8601 durations → minutes", () => {
    assert.equal(parseDurationMinutes("PT8M"), 8);
    assert.equal(parseDurationMinutes("PT1H5M30S"), 65.5);
    assert.equal(parseDurationMinutes("PT0S"), 0);
    assert.equal(parseDurationMinutes("PT0M0S"), 0);
    assert.equal(parseDurationMinutes(undefined), 0);
    assert.equal(parseDurationMinutes("garbage"), 0);
  });

  test("HH:MM:SS → service-day minutes; DepartureDayShift 1 adds a day (01:22 next day = 25:22)", () => {
    assert.equal(parseTxcTime("09:43:00"), 583);
    assert.equal(parseTxcTime("05:51"), 351);
    assert.equal(parseTxcTime("01:22:00", "1"), hm("25:22"));
    assert.throws(() => parseTxcTime("noon"), TypeError);
  });

  test("dayOfWeek and periodCovers", () => {
    assert.equal(dayOfWeek("2026-09-14"), 1); // Monday
    assert.equal(dayOfWeek("2026-09-19"), 6); // Saturday
    assert.equal(periodCovers({ start: "2026-08-30" }, "2026-09-14"), true);
    assert.equal(periodCovers({ start: "2026-08-30" }, "2026-08-29"), false);
    assert.equal(periodCovers({ start: "2026-01-01", end: "2026-06-30" }, "2026-09-14"), false);
    assert.equal(periodCovers(undefined, "2026-09-14"), true);
  });
});

describe("parseOperatingProfile / operatesOn", () => {
  test("MondayToFriday range plus a special day of non-operation", () => {
    const p = parseOperatingProfile({
      RegularDayType: { DaysOfWeek: { MondayToFriday: "" } },
      SpecialDaysOperation: { DaysOfNonOperation: { DateRange: { StartDate: "2026-12-25", EndDate: "2026-12-26" } } },
    });
    assert.deepEqual([...p.daysOfWeek].sort(), [1, 2, 3, 4, 5]);
    assert.equal(operatesOn(p, "2026-09-15").operates, true); // Tuesday
    assert.equal(operatesOn(p, "2026-09-19").operates, false); // Saturday
    assert.equal(operatesOn(p, "2026-12-25").operates, false); // Friday, but excluded
  });

  test("HolidaysOnly never operates on a regular day; SpecialDaysOperation can add a day outside the regular pattern", () => {
    const hol = parseOperatingProfile({ RegularDayType: { HolidaysOnly: "" } });
    assert.equal(operatesOn(hol, "2026-09-15").operates, false);
    const sat = parseOperatingProfile({
      RegularDayType: { DaysOfWeek: { Saturday: "" } },
      SpecialDaysOperation: { DaysOfOperation: { DateRange: { StartDate: "2026-09-15" } } },
    });
    assert.equal(operatesOn(sat, "2026-09-15").operates, true);
    assert.equal(operatesOn(sat, "2026-09-16").operates, false);
  });

  test("serviced organisation: school working days → schoolDaysOnly; holidays-only variant is off in term time", () => {
    const orgs = {
      TERM: { code: "TERM", name: "Borders School Term", workingDays: [{ start: "2026-08-19", end: "2026-10-09" }], holidays: [] },
      HOLS: { code: "HOLS", name: "School Holidays", workingDays: [{ start: "2026-10-12", end: "2026-10-19" }], holidays: [] },
    };
    const term = parseOperatingProfile({
      RegularDayType: { DaysOfWeek: { MondayToFriday: "" } },
      ServicedOrganisationDayType: { DaysOfOperation: { WorkingDays: { ServicedOrganisationRef: "TERM" } } },
    });
    const hols = parseOperatingProfile({
      RegularDayType: { DaysOfWeek: { MondayToFriday: "" } },
      ServicedOrganisationDayType: { DaysOfOperation: { WorkingDays: { ServicedOrganisationRef: "HOLS" } } },
    });
    const t = operatesOn(term, "2026-09-15", orgs);
    assert.equal(t.operates, true);
    assert.equal(t.schoolDaysOnly, true);
    assert.equal(t.calendarAssumed, false);
    assert.equal(operatesOn(hols, "2026-09-15", orgs).operates, false);
    assert.equal(operatesOn(hols, "2026-10-13", orgs).operates, true);
    // DaysOfNonOperation on the term calendar flips the answer.
    const notTerm = parseOperatingProfile({
      RegularDayType: { DaysOfWeek: { MondayToFriday: "" } },
      ServicedOrganisationDayType: { DaysOfNonOperation: { WorkingDays: { ServicedOrganisationRef: "TERM" } } },
    });
    assert.equal(operatesOn(notTerm, "2026-09-15", orgs).operates, false);
  });

  test("expired calendar → assumed operating on regular days and flagged calendarAssumed", () => {
    const orgs = { OLD: { code: "OLD", name: "Every Saturday", workingDays: [{ start: "2025-01-04", end: "2025-12-27" }], holidays: [] } };
    const p = parseOperatingProfile({
      RegularDayType: { DaysOfWeek: { Saturday: "" } },
      ServicedOrganisationDayType: { DaysOfOperation: { WorkingDays: { ServicedOrganisationRef: "OLD" } } },
    });
    const r = operatesOn(p, "2026-09-19", orgs);
    assert.equal(r.operates, true);
    assert.equal(r.calendarAssumed, true);
    assert.equal(r.schoolDaysOnly, false);
  });
});

describe("expandPattern", () => {
  test("departure(k+1) = departure(k) + RunTime + To.WaitTime + next From.WaitTime; overrides replace link timings", () => {
    const sections = {
      s1: [
        { id: "l1", from: "A", to: "B", runTimeMin: 10, fromWaitMin: 0, toWaitMin: 2 },
        { id: "l2", from: "B", to: "C", runTimeMin: 5, fromWaitMin: 1, toWaitMin: 0 },
      ],
    };
    const stops = expandPattern({ sectionRefs: ["s1"] }, sections, hm("07:00"));
    // A dep 07:00; B arr 07:10, dep 07:10+2+1 = 07:13; C arr 07:18
    assert.deepEqual(stops.map((s) => [s.atco, s.arrMin, s.depMin]), [["A", 420, 420], ["B", 430, 433], ["C", 438, 438]]);
    const withOverride = expandPattern({ sectionRefs: ["s1"] }, sections, hm("07:00"), { l1: { runTimeMin: 20 } });
    assert.equal(withOverride[1].arrMin, 440);
    assert.equal(withOverride[2].arrMin, 448);
  });
});

describe("fixture: Arriva X15 Alnwick–Berwick (BODS dataset 15763, Mon–Fri file, trimmed)", () => {
  let txc, expanded;
  before(async () => {
    txc = parseTxc(await parseTxcXml(await readFile(ARRIVA, "utf8")));
    expanded = expandJourneys(txc, { source: "arriva" });
  });

  test("operators, service, line, operating period and Mon–Fri profile at service level", () => {
    assert.equal(txc.operators.tkt_oid.noc, "ANUM");
    assert.equal(txc.operators.tkt_oid.name, "Arriva Northumbria");
    assert.equal(txc.services.length, 1);
    assert.equal(txc.services[0].serviceCode, "PB0002032:496");
    assert.deepEqual(txc.services[0].lines.map((l) => l.name), ["X15"]);
    assert.equal(txc.services[0].operatingPeriod.start, "2026-08-30");
    assert.deepEqual([...txc.services[0].operatingProfile.daysOfWeek].sort(), [1, 2, 3, 4, 5]);
    assert.equal(Object.keys(txc.stopPoints).length, 40);
    assert.equal(txc.stopPoints["3100T994533"].name, "Berwick Railway Station");
    assert.ok(Math.abs(txc.stopPoints["3100T994533"].lat - 55.77) < 0.02);
  });

  test("4 journeys, 40 stops each; vj_1 05:51 Alnwick Bus Station → Charlton Bridge 06:02 → Berwick station 06:48", () => {
    assert.equal(expanded.skipped, 0);
    assert.equal(expanded.journeys.length, 4);
    const j = expanded.journeys[0];
    assert.equal(j.journeyCode, "vj_1");
    assert.equal(j.operatorNoc, "ANUM");
    assert.equal(j.operatorName, "Arriva Northumbria");
    assert.equal(j.lineName, "X15");
    assert.equal(j.direction, "outbound");
    assert.equal(j.source, "arriva");
    assert.equal(j.stops.length, 40);
    assert.equal(j.departureMin, hm("05:51"));
    const at = (atco) => j.stops.find((s) => s.atco === atco);
    assert.equal(at("3100U418613D").depMin, hm("05:51")); // Alnwick Bus Station
    assert.equal(at("3100U169230").depMin, hm("06:02")); // Charlton Bridge (RunTimes 0+1+1+3+3+2+1)
    assert.equal(at("3100T995516").depMin, hm("06:42")); // Berwick Retail Park
    assert.equal(at("3100T993525").depMin, hm("06:44")); // Union Brae
    assert.equal(at("3100T994533").depMin, hm("06:48")); // Berwick Railway Station
    assert.deepEqual(expanded.journeys.map((x) => x.departureMin), [hm("05:51"), hm("10:11"), hm("12:11"), hm("14:11")]);
  });

  test("operates Monday–Friday only, from 2026-08-30", () => {
    const j = expanded.journeys[0];
    assert.equal(operatesOn(j.operatingProfile, "2026-09-15", txc.servicedOrganisations).operates, true);
    assert.equal(operatesOn(j.operatingProfile, "2026-09-19", txc.servicedOrganisations).operates, false);
    assert.equal(periodCovers(j.operatingPeriod, "2026-08-01"), false);
  });
});

describe("fixture: Borders Buses 253 (BODS dataset 21610, Optibus export, trimmed)", () => {
  let txc, expanded;
  before(async () => {
    txc = parseTxc(await parseTxcXml(await readFile(BORDERS, "utf8")));
    expanded = expandJourneys(txc);
  });

  test("operator PERY 'Borders Buses (PB)', line 253, four serviced-organisation calendars", () => {
    assert.equal(txc.operators.PERY.noc, "PERY");
    assert.equal(txc.operators.PERY.name, "Borders Buses (PB)");
    assert.deepEqual(txc.services[0].lines.map((l) => l.name), ["253"]);
    assert.deepEqual(Object.keys(txc.servicedOrganisations).sort(), ["BB5", "BB7", "BB8", "SBNSCH"]);
    assert.equal(txc.servicedOrganisations.SBNSCH.name, "Scottish Borders School Holidays");
    assert.equal(txc.servicedOrganisations.BB5.workingDays.at(-1).end, "2026-12-19");
  });

  test("PT0M0S pattern links + per-journey VehicleJourneyTimingLink overrides: VJ3 07:48 Grantshouse → Houndwood 07:52 → Burnmouth 08:03 → Berwick 08:14", () => {
    assert.equal(expanded.journeys.length, 4);
    const j = expanded.journeys.find((x) => x.journeyCode === "VJ3");
    assert.equal(j.direction, "outbound");
    assert.equal(j.stops.length, 15);
    const at = (atco) => j.stops.find((s) => s.atco === atco);
    assert.equal(at("69001146").depMin, hm("07:48")); // Grantshouse Bus Shelter
    assert.equal(at("69001150").depMin, hm("07:52")); // Houndwood S-Bound: 2 + 0 + 2
    assert.equal(at("6900171").depMin, hm("08:03")); // Burnmouth A1
    assert.equal(at("3100T994533").depMin, hm("08:14")); // Berwick Railway Station
    // Every pattern link is PT0M0S in the file; without the overrides all stops would share 07:48.
    assert.ok(Object.values(txc.sections).flat().every((l) => l.runTimeMin === 0));
  });

  test("journey-level operating profiles: Mon–Thu (BB8), school holidays (SBNSCH), Friday (BB7), Saturday (BB5)", () => {
    const by = Object.fromEntries(expanded.journeys.map((j) => [j.journeyCode, j]));
    const on = (code, date) => operatesOn(by[code].operatingProfile, date, txc.servicedOrganisations);
    assert.equal(by.VJ3.profileSource ?? "journey", "journey");
    // Tuesday 15 Sep 2026 in term time: the Mon–Thu journey runs (calendar last published to June → assumed),
    // the school-holiday variant does not (SBNSCH is maintained to Oct 2026 and 15 Sep is not a holiday).
    assert.equal(on("VJ3", "2026-09-15").operates, true);
    assert.equal(on("VJ3", "2026-09-15").calendarAssumed, true);
    assert.equal(on("VJ21", "2026-09-15").operates, false);
    assert.equal(on("VJ21", "2026-10-13").operates, true); // Oct half-term 12–19 Oct
    assert.equal(on("VJ3", "2026-09-18").operates, false); // Friday → BB7 journey instead
    const fri = on("VJ37", "2026-09-18");
    assert.equal(fri.operates, true);
    assert.equal(fri.schoolDaysOnly, true); // "… Friday Schoolda[ys]"
    assert.equal(on("VJ55", "2026-09-19").operates, true); // Saturday, BB5 runs to Dec 2026
    assert.equal(on("VJ55", "2026-09-19").calendarAssumed, false);
    assert.equal(on("VJ55", "2026-09-20").operates, false); // Sunday
  });
});
