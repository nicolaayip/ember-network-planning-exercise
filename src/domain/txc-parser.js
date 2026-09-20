/**
 * TransXChange 2.4 parser (DESIGN_DOC §4.1). Pure: XML text / xml2js object → operators,
 * serviced organisations, stop points, services with journey patterns, and vehicle journeys
 * expanded to a per-stop departure-time list. No I/O; consumed by src/pipeline/07-supply.js
 * for both BODS and TNDS files (one format, one parser).
 *
 * Quirks handled (all observed in BODS files for admin areas 410/310/690, Sept 2026):
 *  - xml2js with `explicitArray: false` returns a single object where the schema allows many
 *    (one Service, one Line, one JourneyPatternSectionRefs) — `arr()` normalises.
 *  - RunTime / WaitTime are ISO 8601 durations ("PT8M", "PT1H5M30S", "PT0S").
 *  - Optibus exports (Borders Buses 253) put PT0M0S on every JourneyPatternTimingLink and carry the
 *    real run times in per-journey VehicleJourneyTimingLink overrides.
 *  - OperatingProfile lives at Service level with an optional per-VehicleJourney override; day types
 *    appear as individual days, ranges (MondayToFriday, Weekend, …) or HolidaysOnly.
 *  - ServicedOrganisation calendars are used both for school terms and as plain "every Saturday"
 *    calendars; several have not been extended past the last school term, so an expired calendar is
 *    treated as "assume operating on the regular days" and flagged (`calendarAssumed`).
 *  - StopPoints may be AnnotatedStopPointRef (with or without Location) or full StopPoint entries;
 *    Location may be Longitude/Latitude or Easting/Northing.
 */

import { parseStringPromise, processors } from "xml2js";
import { bngToLngLat } from "../lib/geo.js";

/** Normalise xml2js "one or many" children to an array. */
export const arr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

/** Element text whether xml2js gave a string or `{ _: text, $: attrs }`. */
const text = (x) => (x === undefined || x === null ? undefined : typeof x === "object" ? (x._ ?? "").toString().trim() : String(x).trim());

/** Parse a TransXChange XML string into an xml2js object (namespace prefixes stripped). */
export async function parseTxcXml(xml) {
  return parseStringPromise(xml, {
    explicitArray: false,
    trim: true,
    attrkey: "$",
    charkey: "_",
    tagNameProcessors: [processors.stripPrefix],
  });
}

/** "PT1H5M30S" → 65.5 minutes; "PT8M" → 8; "PT0S" → 0. Unknown / absent → 0. */
export function parseDurationMinutes(s) {
  if (!s) return 0;
  const m = /^-?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s).trim());
  if (!m) return 0;
  const [, d, h, min, sec] = m;
  return (Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min ?? 0) + Number(sec ?? 0) / 60;
}

/** "09:43:00" → 583 minutes; honours a DepartureDayShift of +1 (times after midnight). */
export function parseTxcTime(s, dayShift = 0) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s ?? "").trim());
  if (!m) throw new TypeError(`Expected HH:MM[:SS], got ${JSON.stringify(s)}`);
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3] ?? 0) / 60 + Number(dayShift || 0) * 1440;
}

const DAY_GROUPS = {
  Monday: [1], Tuesday: [2], Wednesday: [3], Thursday: [4], Friday: [5], Saturday: [6], Sunday: [0],
  MondayToFriday: [1, 2, 3, 4, 5], MondayToSaturday: [1, 2, 3, 4, 5, 6], MondayToSunday: [0, 1, 2, 3, 4, 5, 6],
  Weekend: [0, 6], NotSaturday: [0, 1, 2, 3, 4, 5], NotSunday: [1, 2, 3, 4, 5, 6],
};

/**
 * OperatingProfile element → { daysOfWeek: Set<0..6>|null, holidaysOnly, specialOperation[], specialNonOperation[],
 * servicedOrganisation: [{ ref, kind: 'operation'|'nonOperation', days: 'working'|'holidays' }] }.
 * `daysOfWeek === null` means the profile did not state regular days (rare).
 */
export function parseOperatingProfile(op) {
  if (!op) return null;
  const out = { daysOfWeek: null, holidaysOnly: false, specialOperation: [], specialNonOperation: [], servicedOrganisation: [] };
  const rdt = op.RegularDayType;
  if (rdt) {
    if (rdt.HolidaysOnly !== undefined) out.holidaysOnly = true;
    if (rdt.DaysOfWeek !== undefined) {
      const days = new Set();
      for (const k of Object.keys(rdt.DaysOfWeek ?? {})) for (const d of DAY_GROUPS[k] ?? []) days.add(d);
      out.daysOfWeek = days;
    }
  }
  const ranges = (node) => arr(node?.DateRange).map((r) => ({ start: text(r.StartDate), end: text(r.EndDate) ?? text(r.StartDate) }));
  if (op.SpecialDaysOperation) {
    out.specialOperation = ranges(op.SpecialDaysOperation.DaysOfOperation);
    out.specialNonOperation = ranges(op.SpecialDaysOperation.DaysOfNonOperation);
  }
  const so = op.ServicedOrganisationDayType;
  if (so) {
    for (const [kind, node] of [["operation", so.DaysOfOperation], ["nonOperation", so.DaysOfNonOperation]]) {
      if (!node) continue;
      for (const ref of arr(node.WorkingDays).flatMap((w) => arr(w.ServicedOrganisationRef).map(text))) out.servicedOrganisation.push({ ref, kind, days: "working" });
      for (const ref of arr(node.Holidays).flatMap((w) => arr(w.ServicedOrganisationRef).map(text))) out.servicedOrganisation.push({ ref, kind, days: "holidays" });
    }
  }
  return out;
}

const inRange = (date, r) => r.start && date >= r.start && (!r.end || date <= r.end);

/** Day of week (0 = Sunday) of an ISO date string, timezone-free. */
export const dayOfWeek = (isoDate) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

const SCHOOL_RE = /school|term|college|academ|pupil|student/i;
const HOLIDAY_RE = /holiday|vacation/i;

/**
 * Does a journey with `profile` operate on `date` (YYYY-MM-DD)?
 * @param {ReturnType<typeof parseOperatingProfile>} profile
 * @param {string} date
 * @param {Record<string, { name: string, workingDays: Array<{start,end}>, holidays: Array<{start,end}> }>} servicedOrganisations
 * @returns {{ operates: boolean, schoolDaysOnly: boolean, calendarAssumed: boolean, reason?: string }}
 */
export function operatesOn(profile, date, servicedOrganisations = {}) {
  const res = { operates: false, schoolDaysOnly: false, calendarAssumed: false };
  if (!profile) return { ...res, reason: "no operating profile" };
  if (profile.specialNonOperation.some((r) => inRange(date, r))) return { ...res, reason: "special day of non-operation" };
  const special = profile.specialOperation.some((r) => inRange(date, r));
  if (profile.holidaysOnly && !special) return { ...res, reason: "bank holidays only" };
  if (!special) {
    if (!profile.daysOfWeek) return { ...res, reason: "no regular days stated" };
    if (!profile.daysOfWeek.has(dayOfWeek(date))) return { ...res, reason: "day of week" };
  }
  for (const so of profile.servicedOrganisation) {
    const org = servicedOrganisations[so.ref];
    const isSchool = org ? SCHOOL_RE.test(org.name) && !HOLIDAY_RE.test(org.name) : false;
    if (so.kind === "operation" && so.days === "working" && isSchool) res.schoolDaysOnly = true;
    if (!org) { res.calendarAssumed = true; continue; }
    const list = so.days === "working" ? org.workingDays : org.holidays;
    const lastDate = list.reduce((m, r) => ((r.end ?? r.start) > m ? (r.end ?? r.start) : m), "");
    const known = list.length > 0 && date <= lastDate;
    if (!known) {
      // Calendar not maintained up to `date` (observed: school-term calendars ending at the last term
      // published). Assume the regular-days answer, i.e. "working" calendars are working, "holidays" are not.
      res.calendarAssumed = true;
      const assumedActive = so.days === "working";
      if ((so.kind === "operation") !== assumedActive) return { ...res, reason: `serviced organisation ${so.ref} (assumed)` };
      continue;
    }
    const active = list.some((r) => inRange(date, r));
    if (so.kind === "operation" && !active) return { ...res, reason: `serviced organisation ${so.ref} not active` };
    if (so.kind === "nonOperation" && active) return { ...res, reason: `serviced organisation ${so.ref} active (non-operation)` };
  }
  res.operates = true;
  return res;
}

function parseStopPoints(sp) {
  const out = {};
  for (const s of arr(sp?.AnnotatedStopPointRef)) {
    const atco = text(s.StopPointRef);
    if (atco) out[atco] = { atco, name: text(s.CommonName) ?? "", ...location(s.Location) };
  }
  for (const s of arr(sp?.StopPoint)) {
    const atco = text(s.AtcoCode);
    if (atco) out[atco] = { atco, name: text(s.Descriptor?.CommonName) ?? "", ...location(s.Place?.Location) };
  }
  return out;
}

function location(loc) {
  if (!loc) return {};
  const lng = text(loc.Longitude ?? loc.Translation?.Longitude), lat = text(loc.Latitude ?? loc.Translation?.Latitude);
  if (lng && lat && Number.isFinite(Number(lng)) && Number.isFinite(Number(lat))) return { lat: Number(lat), lng: Number(lng) };
  const e = text(loc.Easting ?? loc.Translation?.Easting), n = text(loc.Northing ?? loc.Translation?.Northing);
  if (e && n) return bngToLngLat(e, n);
  return {};
}

function parseServicedOrganisations(node) {
  const out = {};
  for (const so of arr(node?.ServicedOrganisation)) {
    const code = text(so.OrganisationCode);
    if (!code) continue;
    const ranges = (n) => arr(n?.DateRange).map((r) => ({ start: text(r.StartDate), end: text(r.EndDate) ?? text(r.StartDate) }));
    out[code] = { code, name: text(so.Name) ?? code, workingDays: ranges(so.WorkingDays), holidays: ranges(so.Holidays) };
  }
  return out;
}

function parseOperators(node) {
  const out = {};
  for (const o of [...arr(node?.Operator), ...arr(node?.LicensedOperator)]) {
    const id = o.$?.id ?? text(o.OperatorCode) ?? text(o.NationalOperatorCode);
    const rec = {
      id,
      noc: text(o.NationalOperatorCode) ?? text(o.OperatorCode) ?? id,
      name: text(o.OperatorShortName) ?? text(o.TradingName) ?? text(o.OperatorNameOnLicence) ?? id,
    };
    out[id] = rec;
    if (rec.noc && !out[rec.noc]) out[rec.noc] = rec;
  }
  return out;
}

/** JourneyPatternSections → { sectionId: [{ id, from, to, runTimeMin, fromWaitMin, toWaitMin }] } */
function parseSections(node) {
  const out = {};
  for (const s of arr(node?.JourneyPatternSection)) {
    out[s.$?.id] = arr(s.JourneyPatternTimingLink).map((l) => ({
      id: l.$?.id,
      from: text(l.From?.StopPointRef),
      to: text(l.To?.StopPointRef),
      runTimeMin: parseDurationMinutes(text(l.RunTime)),
      fromWaitMin: parseDurationMinutes(text(l.From?.WaitTime)),
      toWaitMin: parseDurationMinutes(text(l.To?.WaitTime)),
    }));
  }
  return out;
}

/**
 * Parse an xml2js TransXChange object.
 * @returns {{ operators, servicedOrganisations, stopPoints, sections, services: Array, vehicleJourneys: Array, meta }}
 */
export function parseTxc(doc) {
  const root = doc?.TransXChange ?? doc;
  if (!root || typeof root !== "object") throw new TypeError("not a TransXChange document");
  const operators = parseOperators(root.Operators);
  const servicedOrganisations = parseServicedOrganisations(root.ServicedOrganisations);
  const stopPoints = parseStopPoints(root.StopPoints);
  const sections = parseSections(root.JourneyPatternSections);

  const services = arr(root.Services?.Service).map((s) => {
    const lines = arr(s.Lines?.Line).map((l) => ({ id: l.$?.id, name: text(l.LineName) ?? "" }));
    const patterns = {};
    for (const jp of arr(s.StandardService?.JourneyPattern)) {
      patterns[jp.$?.id] = {
        id: jp.$?.id,
        direction: text(jp.Direction) ?? "",
        sectionRefs: arr(jp.JourneyPatternSectionRefs).map(text),
        operatorRef: text(jp.OperatorRef),
      };
    }
    return {
      serviceCode: text(s.ServiceCode) ?? "",
      lines,
      operatingPeriod: { start: text(s.OperatingPeriod?.StartDate), end: text(s.OperatingPeriod?.EndDate) },
      operatingProfile: parseOperatingProfile(s.OperatingProfile),
      operatorRef: text(s.RegisteredOperatorRef),
      description: text(s.Description),
      patterns,
    };
  });
  const byServiceCode = Object.fromEntries(services.map((s) => [s.serviceCode, s]));
  const lineById = {};
  for (const s of services) for (const l of s.lines) lineById[l.id] = l.name;

  const vehicleJourneys = [];
  for (const vj of arr(root.VehicleJourneys?.VehicleJourney)) {
    const serviceRef = text(vj.ServiceRef);
    const service = byServiceCode[serviceRef] ?? services[0];
    const jpRef = text(vj.JourneyPatternRef);
    const overrides = {};
    for (const t of arr(vj.VehicleJourneyTimingLink)) {
      const ref = text(t.JourneyPatternTimingLinkRef);
      if (!ref) continue;
      overrides[ref] = {
        runTimeMin: t.RunTime !== undefined ? parseDurationMinutes(text(t.RunTime)) : undefined,
        fromWaitMin: t.From?.WaitTime !== undefined ? parseDurationMinutes(text(t.From.WaitTime)) : undefined,
        toWaitMin: t.To?.WaitTime !== undefined ? parseDurationMinutes(text(t.To.WaitTime)) : undefined,
      };
    }
    vehicleJourneys.push({
      code: text(vj.VehicleJourneyCode) ?? "",
      sequenceNumber: vj.$?.SequenceNumber,
      serviceRef,
      lineRef: text(vj.LineRef),
      lineName: lineById[text(vj.LineRef)] ?? service?.lines?.[0]?.name ?? "",
      journeyPatternRef: jpRef,
      vehicleJourneyRef: text(vj.VehicleJourneyRef),
      departureMin: vj.DepartureTime !== undefined ? parseTxcTime(text(vj.DepartureTime), text(vj.DepartureDayShift)) : null,
      operatorRef: text(vj.OperatorRef) ?? service?.operatorRef,
      operatingProfile: vj.OperatingProfile ? parseOperatingProfile(vj.OperatingProfile) : service?.operatingProfile ?? null,
      profileSource: vj.OperatingProfile ? "journey" : "service",
      timingOverrides: overrides,
    });
  }

  return {
    meta: { schemaVersion: root.$?.SchemaVersion, fileName: root.$?.FileName, modified: root.$?.ModificationDateTime, revision: root.$?.RevisionNumber },
    operators,
    servicedOrganisations,
    stopPoints,
    sections,
    services,
    vehicleJourneys,
  };
}

/**
 * Ordered stop list with departure minutes for a journey pattern, given a departure time and
 * optional per-journey timing overrides (keyed by JourneyPatternTimingLink id).
 *
 * departure(stop k+1) = departure(stop k) + RunTime(link k) + WaitTime(To of link k) + WaitTime(From of link k+1)
 *
 * @returns {Array<{ atco: string, depMin: number, arrMin: number }>}
 */
export function expandPattern(pattern, sections, departureMin, overrides = {}) {
  const links = pattern.sectionRefs.flatMap((ref) => sections[ref] ?? []);
  if (links.length === 0) return [];
  const eff = (l) => ({ ...l, ...Object.fromEntries(Object.entries(overrides[l.id] ?? {}).filter(([, v]) => v !== undefined)) });
  const stops = [];
  let t = departureMin;
  const first = eff(links[0]);
  stops.push({ atco: first.from, arrMin: t, depMin: t + first.fromWaitMin });
  t += first.fromWaitMin;
  for (let i = 0; i < links.length; i++) {
    const l = eff(links[i]);
    const arr_ = t + l.runTimeMin;
    const nextFromWait = i + 1 < links.length ? eff(links[i + 1]).fromWaitMin : 0;
    const dep = arr_ + l.toWaitMin + nextFromWait;
    stops.push({ atco: l.to, arrMin: arr_, depMin: dep });
    t = dep;
  }
  return stops;
}

/**
 * Expand every vehicle journey of a parsed file to its stop/time sequence.
 * Journeys without a resolvable pattern (e.g. VehicleJourneyRef indirection) are skipped and counted.
 *
 * @param {ReturnType<typeof parseTxc>} txc
 * @param {{ source?: string }} [opts]  provenance label copied onto each journey
 * @returns {{ journeys: Array, skipped: number }}
 */
export function expandJourneys(txc, opts = {}) {
  const journeys = [];
  let skipped = 0;
  const byServiceCode = Object.fromEntries(txc.services.map((s) => [s.serviceCode, s]));
  for (const vj of txc.vehicleJourneys) {
    const service = byServiceCode[vj.serviceRef] ?? txc.services[0];
    const pattern = service?.patterns?.[vj.journeyPatternRef];
    if (!pattern || vj.departureMin === null) { skipped++; continue; }
    const stops = expandPattern(pattern, txc.sections, vj.departureMin, vj.timingOverrides);
    if (stops.length < 2) { skipped++; continue; }
    const op = txc.operators[vj.operatorRef] ?? txc.operators[pattern.operatorRef] ?? txc.operators[service?.operatorRef] ?? Object.values(txc.operators)[0];
    journeys.push({
      source: opts.source ?? txc.meta.fileName ?? "",
      serviceCode: service?.serviceCode ?? "",
      operatorNoc: op?.noc ?? "",
      operatorName: op?.name ?? op?.noc ?? "",
      lineName: vj.lineName,
      direction: pattern.direction,
      journeyCode: vj.code,
      departureMin: vj.departureMin,
      operatingPeriod: service?.operatingPeriod ?? {},
      operatingProfile: vj.operatingProfile,
      stops,
    });
  }
  return { journeys, skipped };
}

/** Is the service's OperatingPeriod in force on `date`? Missing dates are treated as open-ended. */
export function periodCovers(period, date) {
  if (!period) return true;
  if (period.start && date < period.start) return false;
  if (period.end && date > period.end) return false;
  return true;
}
