/**
 * Pipeline step 7 — SUPPLY.
 *
 * 1. Load BODS admin-area feeds, long-distance coach zip, and TNDS Scotland (when present).
 * 2. Scan and parse TransXChange; match journeys through route stops (≥ 2 in order, with tolerance aliases).
 * 3. Filter by reference dates; dedupe; chain sectional registrations into through journeys.
 * 4. Flatten per-pair timelines; peak-filter headway gaps → write pair.supplyVector (weekday + Saturday).
 *
 * Degrades to empty supply vectors when no source is available.
 * School-day-only journeys excluded from weekday unless configured.
 *
 * @format
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import {
  forEachTxcFile,
  loadAdminAreas,
  loadCoachZip,
  readTxcEntry,
} from "../adapters/bods.js";
import { loadNaptan } from "../adapters/naptan.js";
import {
  parseTxcXml,
  parseTxc,
  expandJourneys,
  operatesOn,
  periodCovers,
} from "../domain/txc-parser.js";
import {
  flattenJourneys,
  dedupeJourneys,
  chainJourneys,
  pairKey,
} from "../domain/link-flattening.js";
import { DEFAULT_DAY_START_MIN, DEFAULT_DAY_END_MIN } from "../domain/headway.js";
import { gapsForTimeline, peakBandsForDirection } from "../domain/market-openings.js";
import { DIRECTIONS, emptySupplyVector, isPassenger } from "../domain/document.js";
import { haversineMetres } from "../lib/geo.js";
import { formatHHMM } from "../lib/time.js";

export const name = "supply";

const DEFAULT_ADMIN_AREAS = [410, 310, 690];
const DEFAULT_TOLERANCE_M = 50;
const DAY_TYPES = ["weekday", "saturday", "sunday"];

export async function run(ctx) {
  const { document: doc, config, log } = ctx;
  const cfg = config.supply ?? {}; // not yet in config.js — see step-8 report; defaults below
  const settings = {
    adminAreas: cfg.adminAreas ?? DEFAULT_ADMIN_AREAS,
    toleranceM: cfg.stopToleranceM ?? DEFAULT_TOLERANCE_M,
    thresholdMinutes: config.engine.headwayGapThresholdMinutes,
    dayStartMin: cfg.dayStartMin ?? DEFAULT_DAY_START_MIN,
    dayEndMin: cfg.dayEndMin ?? DEFAULT_DAY_END_MIN,
    includeSchoolDayJourneys: cfg.includeSchoolDayJourneys ?? false,
    includeCoachZip: cfg.includeCoachZip ?? true,
    chainMaxWaitMin: cfg.chainMaxWaitMin ?? 20, // sectional registrations joined when the next section leaves within this
    chainJunctionRadiusM: cfg.chainJunctionRadiusM ?? 150, // … from a stop within this distance (bus-station stands)
  };
  const referenceDates = buildReferenceDates(cfg.referenceDate ?? isoToday());

  // 1. Sources -------------------------------------------------------------------------------------
  const sources = await gatherSources(settings, log, config);
  const archives = txcArchives(sources);
  if (archives.length === 0) {
    log.warn(
      { bods: sources.bods.listingSource, tnds: sources.tnds?.reason },
      "supply skipped — no timetable source available; supplyVector left at defaults",
    );
    resetSupplyVectors(doc);
    ctx.supply = {
      status: "unavailable",
      referenceDates,
      sources: describeSources(sources),
    };
    return ctx;
  }

  // 2. Scan pass: one TXC at a time → stop index + lightweight file refs (no bulk XML retention)
  const routeStops = Object.fromEntries(
    DIRECTIONS.map((d) => [d, doc.directions[d].orderedStops.filter(isPassenger)]),
  ); // depot: no competing services
  const ourIds = new Set(DIRECTIONS.flatMap((d) => routeStops[d].map((s) => s.naptanId)));
  const stopIndex = new Map();
  const allFiles = [];
  const fileCounts = {};
  const pool = createTxcScanPool();
  for (const { path: archivePath, source } of archives) {
    await forEachTxcFile(archivePath, async ({ name, xml }) => {
      fileCounts[source] = (fileCounts[source] ?? 0) + 1;
      const { atcos, lines } = scanTxcXml(xml, stopIndex, pool);
      allFiles.push({ path: archivePath, name, source, atcos, lines });
    });
  }
  await fillMissingCoordinates(stopIndex, ctx, log);
  const { aliases, toleranceMatches } = toleranceAliases(
    routeStops,
    stopIndex,
    ourIds,
    settings.toleranceM,
  );
  const candidateIds = new Set([
    ...ourIds,
    ...Object.keys(aliases.outbound),
    ...Object.keys(aliases.return),
  ]);
  // Files touching ≥ 1 of our stops, plus every other file of the same dataset + line (sectional
  // registrations of one route live in separate files and are chained below).
  const direct = allFiles.filter(
    (f) => countInAtcos(f.atcos, candidateIds, pool.atcos) >= 1,
  );
  const lineKeys = new Set(
    direct.flatMap((f) => [...f.lines].map((i) => `${f.source}|${pool.lines[i]}`)),
  );
  const candidates = allFiles.filter(
    (f) =>
      direct.includes(f) ||
      [...f.lines].some((i) => lineKeys.has(`${f.source}|${pool.lines[i]}`)),
  );
  const coordsOf = (atco) => {
    const s = stopIndex.get(atco);
    return s?.lat !== undefined ? { lat: s.lat, lng: s.lng } : undefined;
  };
  log.info(
    {
      files: allFiles.length,
      candidateFiles: candidates.length,
      txcStops: stopIndex.size,
      toleranceAliases: toleranceMatches.length,
    },
    "supply: files scanned",
  );

  // 3. Parse candidates → journeys ------------------------------------------------------------------
  const parsed = await parseCandidates(candidates, log);

  // 4. Day-type selection, dedupe, flatten per direction --------------------------------------------
  const perDay = {};
  for (const dayType of DAY_TYPES) {
    const date = referenceDates[dayType];
    const sel = selectJourneys(parsed.journeys, date, settings.includeSchoolDayJourneys);
    const deduped = dedupeJourneys(sel.journeys);
    const chained = chainJourneys(deduped.journeys, {
      coordsOf,
      maxWaitMin: settings.chainMaxWaitMin,
      junctionRadiusM: settings.chainJunctionRadiusM,
    });
    perDay[dayType] = {
      date,
      journeys: chained.journeys,
      duplicates: deduped.duplicates,
      chains: chained.chains,
      segmentsJoined: chained.segmentsJoined,
      schoolDayOnlyExcluded: sel.schoolDayOnlyExcluded,
      calendarAssumed: sel.calendarAssumed,
      byDirection: {},
    };
    for (const d of DIRECTIONS) {
      const ids = routeStops[d].map((s) => s.naptanId);
      perDay[dayType].byDirection[d] = flattenJourneys(chained.journeys, ids, {
        aliases: aliases[d],
      });
    }
  }

  // 5. Write supplyVector on each pair --------------------------------------------------------------
  const tw = doc.estimatedTemporalWindows;
  const trafficProfile = doc.trafficProfile;
  const noCompetitor = [];
  let pairsWithSupply = 0;
  for (const d of DIRECTIONS) {
    const dir = doc.directions[d];
    const ids = routeStops[d].map((s) => s.naptanId);
    const idx = new Map(ids.map((id, i) => [id, i]));
    for (const pair of dir.directionalODPairs) {
      const k = pairKey(idx.get(pair.originStopId), idx.get(pair.destinationStopId));
      const wk = supplyDaySlice(
        perDay.weekday.byDirection[d].timelines.get(k) ?? [],
        tw,
        trafficProfile,
        d,
        "weekday",
        settings,
      );
      const sat = supplyDaySlice(
        perDay.saturday.byDirection[d].timelines.get(k) ?? [],
        tw,
        trafficProfile,
        d,
        "saturday",
        settings,
      );
      pair.supplyVector = {
        detectedOverlappingLines: wk.lines,
        calculatedHeadwayGaps: mapSchemaGaps(wk.schemaGaps),
        saturdayHeadwayGaps: mapSchemaGaps(sat.schemaGaps),
        competitorDepartures: wk.departures,
        saturdayDetectedOverlappingLines: sat.lines,
        saturdayCompetitorDepartures: sat.departures,
      };
      if (wk.departures.length === 0) noCompetitor.push(`${d}:${pair.pairId}`);
      else pairsWithSupply++;
    }
  }

  const retained = retainedServices(perDay, routeStops);
  const coverage = coverageGaps(routeStops, sources);
  ctx.supply = {
    status: "ok",
    referenceDates,
    sources: describeSources(sources, fileCounts),
    pairsWithSupply,
    pairsWithoutSupply: noCompetitor.length,
  };

  log.info(
    {
      retainedServices: retained.length,
      pairsWithSupply,
      pairsWithoutSupply: noCompetitor.length,
      toleranceMatches: toleranceMatches.length,
      incompleteStops: coverage.incompleteStops?.length ?? 0,
      tnds: sourcesTndsOk(sources) ? "loaded" : "absent",
      filesScanned: allFiles.length,
      filesParsed: candidates.length,
      journeysExpanded: parsed.journeys.length,
    },
    "supply vectors filled",
  );
  return ctx;
}

function supplyDaySlice(timeline, tw, trafficProfile, direction, dayType, settings) {
  const depMins = timeline.map((t) => t.depMin);
  const peakDayType = dayType === "weekday" ? "weekday" : "weekend";
  const peakBands = peakBandsForDirection(tw, trafficProfile, direction, peakDayType);
  const { schemaGaps } = gapsForTimeline(
    depMins,
    peakBands,
    settings.thresholdMinutes,
    settings.dayStartMin,
    settings.dayEndMin,
  );
  return {
    departures: timeline.map((t) => ({ time: formatHHMM(t.depMin), service: t.service })),
    lines: [...new Set(timeline.map((t) => t.service))].sort(),
    schemaGaps,
  };
}

const mapSchemaGaps = (gaps) =>
  gaps.map(
    ({ gapStart, gapEnd, durationMinutes, isMarketOpening, peakOverlapMinutes }) => ({
      gapStart,
      gapEnd,
      durationMinutes,
      isMarketOpening,
      ...(peakOverlapMinutes != null ? { peakOverlapMinutes } : {}),
    }),
  );

// ---------------------------------------------------------------------------------------------------
// Sources

async function loadTndsScotlandZip({ log, config }) {
  const file =
    config.supply?.tndsScotlandZip || path.join(config.paths.data, "tnds", "S.zip");
  try {
    await stat(file);
  } catch {
    return {
      file,
      reason: `TNDS Scotland zip not found at ${path.relative(config.root, file)} (register at travelinedata.org.uk, download region S, set TNDS_SCOTLAND_ZIP)`,
    };
  }
  log?.info?.({ file: path.relative(config.root, file) }, "tnds scotland ready");
  return { file };
}

async function gatherSources(settings, log, config) {
  const sources = {
    bods: { listingSource: "none", perArea: {}, datasets: [] },
    coach: null,
    tnds: null,
  };
  try {
    sources.bods = await loadAdminAreas(settings.adminAreas, { log });
  } catch (err) {
    log.warn({ reason: err.message }, "BODS unavailable");
  }
  if (settings.includeCoachZip) {
    try {
      sources.coach = await loadCoachZip({ log });
    } catch (err) {
      log.warn({ reason: err.message }, "coach zip unavailable");
    }
  }
  try {
    sources.tnds = await loadTndsScotlandZip({ log, config });
    if (sources.tnds.reason)
      log.warn(
        { reason: sources.tnds.reason },
        "TNDS Scotland not loaded — Scottish-registered operators missing from supply",
      );
  } catch (err) {
    sources.tnds = { files: [], reason: err.message };
    log.warn({ reason: err.message }, "TNDS Scotland failed to load");
  }
  return sources;
}

function txcArchives(sources) {
  const archives = sources.bods.datasets
    .filter((d) => d.file)
    .map((d) => ({ path: d.file, source: `bods:${d.id}` }));
  if (sources.coach?.file) archives.push({ path: sources.coach.file, source: "coach" });
  if (sources.tnds?.file && !sources.tnds.reason)
    archives.push({ path: sources.tnds.file, source: "tnds" });
  return archives;
}

function describeSources(s, fileCounts = {}) {
  const bodsTotal = Object.entries(fileCounts)
    .filter(([k]) => k.startsWith("bods:"))
    .reduce((n, [, c]) => n + c, 0);
  return {
    bods: {
      listingSource: s.bods.listingSource,
      perAdminArea: s.bods.perArea,
      datasets: s.bods.datasets.map((d) => ({
        id: d.id,
        operator: d.operatorName,
        noc: d.noc,
        lines: d.lines.length,
        adminAreas: d.adminAreas,
        files: fileCounts[`bods:${d.id}`] ?? 0,
        modified: d.modified,
        ...(d.error ? { error: d.error } : {}),
      })),
      files: bodsTotal,
    },
    coach: s.coach
      ? {
          url: "https://coach.bus-data.dft.gov.uk/TxC-2.4.zip",
          files: fileCounts.coach ?? 0,
        }
      : { files: 0, reason: "not available" },
    tnds: sourcesTndsOk(s)
      ? { file: s.tnds.file, files: fileCounts.tnds ?? 0 }
      : { files: 0, reason: s.tnds?.reason ?? "not available" },
  };
}

const sourcesTndsOk = (s) => s.tnds?.file && !s.tnds.reason;

// ---------------------------------------------------------------------------------------------------
// Stop index (regex, cheap) and tolerance aliases

const RE_ANNOTATED =
  /<(?:\w+:)?AnnotatedStopPointRef\b[^>]*>([\s\S]*?)<\/(?:\w+:)?AnnotatedStopPointRef>/g;
const RE_STOPPOINT = /<(?:\w+:)?StopPoint\b[^>]*>([\s\S]*?)<\/(?:\w+:)?StopPoint>/g;
const RE_LINENAME = /<(?:\w+:)?LineName>\s*([^<]*?)\s*</g;
const tagText = (block, tag) =>
  new RegExp(`<(?:\\w+:)?${tag}>\\s*([^<]*?)\\s*<`).exec(block)?.[1];
// Break V8 slice retention: interned strings must not reference parent TXC buffers.
const copy = (s) =>
  s ? Buffer.from(String(s), "utf8").toString("utf8").trim() : undefined;

function createTxcScanPool() {
  const atcos = [];
  const lines = [];
  const atcoIdx = new Map();
  const lineIdx = new Map();
  const intern = (map, list, s) => {
    const c = copy(s);
    if (!c) return null;
    let i = map.get(c);
    if (i === undefined) {
      i = list.length;
      list.push(c);
      map.set(c, i);
    }
    return i;
  };
  return {
    atcos,
    lines,
    internAtco: (s) => intern(atcoIdx, atcos, s),
    internLine: (s) => intern(lineIdx, lines, s),
  };
}

/** Regex scan of one TXC file: merge stops into `index`, return interned atco/line ids for candidate filtering. */
function scanTxcXml(xml, index, pool) {
  const atcos = new Set();
  const lines = new Set();
  for (const m of xml.matchAll(RE_LINENAME)) {
    const i = pool.internLine(m[1]);
    if (i !== null) lines.add(i);
  }
  const add = (atco, name, lat, lng) => {
    if (!atco) return;
    const cur = index.get(atco);
    if (cur?.lat !== undefined) return;
    index.set(atco, {
      atco,
      name: name ?? cur?.name ?? "",
      ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}),
    });
  };
  for (const m of xml.matchAll(RE_ANNOTATED)) {
    const b = m[1];
    const atco = copy(tagText(b, "StopPointRef"));
    const i = pool.internAtco(atco);
    if (i !== null) atcos.add(i);
    add(
      atco,
      copy(tagText(b, "CommonName")),
      Number(tagText(b, "Latitude")),
      Number(tagText(b, "Longitude")),
    );
  }
  for (const m of xml.matchAll(RE_STOPPOINT)) {
    const b = m[1];
    const atco = copy(tagText(b, "AtcoCode"));
    const i = pool.internAtco(atco);
    if (i !== null) atcos.add(i);
    add(
      atco,
      copy(tagText(b, "CommonName")),
      Number(tagText(b, "Latitude")),
      Number(tagText(b, "Longitude")),
    );
  }
  return { atcos, lines };
}

function countInAtcos(indices, candidateIds, atcoList) {
  let c = 0;
  for (const i of indices) if (candidateIds.has(atcoList[i])) c++;
  return c;
}

/** TXC stops without coordinates get them from NaPTAN (loaded once, ~8 s) when any are missing. */
async function fillMissingCoordinates(stopIndex, ctx, log) {
  const missing = [...stopIndex.values()].filter((s) => s.lat === undefined);
  if (missing.length === 0) return;
  try {
    const naptan = ctx.naptan ?? (ctx.naptan = await loadNaptan({ log }));
    let filled = 0;
    for (const s of missing) {
      const n = naptan.get(s.atco);
      if (n) {
        s.lat = n.lat;
        s.lng = n.lng;
        if (!s.name) s.name = n.name;
        filled++;
      }
    }
    log.debug(
      { missing: missing.length, filled },
      "supply: TXC stop coordinates from NaPTAN",
    );
  } catch (err) {
    log.warn(
      { missing: missing.length, reason: err.message },
      "supply: NaPTAN unavailable for TXC stops without coordinates",
    );
  }
}

/**
 * Competitor stops within `toleranceM` of one of our stops that are not themselves on our route
 * (either direction — the other kerb-side is on the return list). Per direction: atco → route index.
 */
function toleranceAliases(routeStops, stopIndex, ourIds, toleranceM) {
  const aliases = { outbound: {}, return: {} };
  const matches = [];
  const located = [...stopIndex.values()].filter(
    (s) => s.lat !== undefined && !ourIds.has(s.atco),
  );
  for (const d of DIRECTIONS) {
    const best = new Map(); // competitor atco → { index, distanceM }
    routeStops[d].forEach((rs, i) => {
      for (const s of located) {
        const dm = haversineMetres(rs.coordinates, s);
        if (dm > toleranceM) continue;
        const cur = best.get(s.atco);
        if (!cur || dm < cur.distanceM)
          best.set(s.atco, {
            index: i,
            distanceM: Math.round(dm),
            routeStopId: rs.naptanId,
            routeStopName: rs.stopName,
            txcName: s.name,
          });
      }
    });
    for (const [atco, b] of best) {
      aliases[d][atco] = b.index;
      matches.push({
        direction: d,
        routeStopId: b.routeStopId,
        routeStopName: b.routeStopName,
        txcStopId: atco,
        txcStopName: b.txcName,
        distanceM: b.distanceM,
      });
    }
  }
  return { aliases, toleranceMatches: matches };
}

// ---------------------------------------------------------------------------------------------------
// Parsing and selection

async function parseCandidates(files, log) {
  const journeys = [];
  let failures = 0,
    skipped = 0;
  for (const f of files) {
    try {
      const txc = parseTxc(await parseTxcXml(await readTxcEntry(f.path, f.name)));
      const r = expandJourneys(txc, { source: `${f.source}/${f.name}` });
      skipped += r.skipped;
      for (const j of r.journeys) {
        j.servicedOrganisations = txc.servicedOrganisations;
        journeys.push(j);
      }
    } catch (err) {
      failures++;
      log.warn(
        { file: f.name, source: f.source, reason: err.message },
        "supply: TXC parse failed",
      );
    }
  }
  return { journeys, failures, skipped };
}

function selectJourneys(journeys, date, includeSchoolDays) {
  const out = [];
  let schoolDayOnlyExcluded = 0,
    calendarAssumed = 0;
  for (const j of journeys) {
    if (!periodCovers(j.operatingPeriod, date)) continue;
    const r = operatesOn(j.operatingProfile, date, j.servicedOrganisations);
    if (!r.operates) continue;
    if (r.calendarAssumed) calendarAssumed++;
    if (r.schoolDaysOnly && !includeSchoolDays) {
      schoolDayOnlyExcluded++;
      continue;
    }
    out.push(j);
  }
  return { journeys: out, schoolDayOnlyExcluded, calendarAssumed };
}

// ---------------------------------------------------------------------------------------------------
// Reporting helpers

function retainedServices(perDay, routeStops) {
  const byKey = new Map();
  for (const d of DIRECTIONS) {
    for (const t of DAY_TYPES) {
      for (const [key, svc] of perDay[t].byDirection[d].services) {
        const k = `${d}|${key}`;
        const rec = byKey.get(k) ?? {
          operator: svc.operator,
          noc: svc.noc,
          line: svc.line,
          txcDirection: svc.direction,
          routeDirection: d,
          journeysPerDay: { weekday: 0, saturday: 0, sunday: 0 },
          sharedStops: new Set(),
        };
        rec.journeysPerDay[t] = svc.journeys;
        for (const i of svc.stopIndices) rec.sharedStops.add(i);
        byKey.set(k, rec);
      }
    }
  }
  return [...byKey.values()]
    .map((r) => ({
      ...r,
      sharedStops: [...r.sharedStops]
        .sort((a, b) => a - b)
        .map((i) => routeStops[r.routeDirection][i].stopName),
    }))
    .sort(
      (a, b) =>
        a.routeDirection.localeCompare(b.routeDirection) ||
        b.journeysPerDay.weekday - a.journeysPerDay.weekday,
    );
}

/** Stops whose NPTG admin area (first 3 ATCO digits) is covered by no loaded dataset → supply incomplete. */
function coverageGaps(routeStops, sources) {
  const covered = new Set(
    sources.bods.datasets.filter((d) => d.file).flatMap((d) => d.adminAreas),
  );
  const tndsLoaded = sourcesTndsOk(sources);
  const incomplete = [];
  for (const d of DIRECTIONS) {
    for (const s of routeStops[d]) {
      const area = s.naptanId.slice(0, 3);
      const scottish = /^6\d\d$/.test(area);
      if (!covered.has(area) && !(scottish && tndsLoaded)) {
        incomplete.push({
          direction: d,
          naptanId: s.naptanId,
          stopName: s.stopName,
          adminArea: area,
          reason: scottish
            ? "no BODS dataset for this admin area; TNDS Scotland not loaded"
            : "no BODS dataset for this admin area",
        });
      }
    }
  }
  return {
    coveredAdminAreas: [...covered].sort(),
    tndsLoaded,
    incompleteStops: incomplete,
  };
}

function resetSupplyVectors(doc) {
  for (const d of DIRECTIONS)
    for (const p of doc.directions[d].directionalODPairs)
      p.supplyVector = emptySupplyVector();
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

/** Next Tuesday / Saturday / Sunday on or after `fromIso` (a Tuesday is the representative term-time weekday). */
export function buildReferenceDates(fromIso) {
  const base = new Date(`${fromIso}T00:00:00Z`);
  const next = (dow) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + ((dow - d.getUTCDay() + 7) % 7));
    return d.toISOString().slice(0, 10);
  };
  return { weekday: next(2), saturday: next(6), sunday: next(0) };
}
