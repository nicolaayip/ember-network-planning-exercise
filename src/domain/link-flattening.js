/**
 * OD-pair supply filter and chronological link flattening (DESIGN_DOC §4.2–4.3). Pure.
 *
 * A competitor journey is retained for one of our directions when its ordered stop sequence
 * matches at least two of that direction's stops in route order — i.e. it serves at least one
 * of our directional OD pairs (origin before destination on the route). Each retained journey
 * is split into directed links: for every pair (i < j) of matched stops, the departure time at
 * stop i is appended to that pair's timeline.
 */

/**
 * Build a matcher from our ordered stop ids plus optional tolerance aliases
 * (competitor ATCO → our stop index, for stops within e.g. 50 m that are not themselves on our route).
 *
 * @param {string[]} routeStopIds
 * @param {Record<string, number>} [aliases]  competitor atco → route index
 * @returns {{ indexOf: (atco: string) => { index: number, viaTolerance: boolean } | undefined, size: number }}
 */
export function buildStopMatcher(routeStopIds, aliases = {}) {
  const exact = new Map(routeStopIds.map((id, i) => [id, i]));
  return {
    size: routeStopIds.length,
    indexOf(atco) {
      const i = exact.get(atco);
      if (i !== undefined) return { index: i, viaTolerance: false };
      const a = aliases[atco];
      if (a !== undefined && !exact.has(atco)) return { index: a, viaTolerance: true };
      return undefined;
    },
  };
}

/**
 * Match a journey's stop sequence against our route. Returns the monotonic (increasing route index)
 * subsequence of matches in journey order, so a journey that loops back or runs the opposite way
 * cannot produce a forward pair.
 *
 * @param {Array<{ atco: string, depMin: number }>} journeyStops
 * @param {ReturnType<typeof buildStopMatcher>} matcher
 * @returns {Array<{ routeIndex: number, journeyIndex: number, depMin: number, viaTolerance: boolean }>}
 */
export function matchJourney(journeyStops, matcher) {
  const out = [];
  let last = -1;
  for (let k = 0; k < journeyStops.length; k++) {
    const m = matcher.indexOf(journeyStops[k].atco);
    if (!m || m.index <= last) continue;
    out.push({ routeIndex: m.index, journeyIndex: k, depMin: journeyStops[k].depMin, viaTolerance: m.viaTolerance });
    last = m.index;
  }
  return out;
}

/** §4.2: serves at least one directional OD pair (≥2 route stops matched in order). */
export function sharesVector(matches) {
  return matches.length >= 2;
}

/**
 * §4.3: directed links (i < j) from a retained journey's matches.
 * @returns {Array<{ originIndex: number, destIndex: number, depMin: number }>}
 */
export function journeyLinks(matches) {
  const links = [];
  for (let a = 0; a < matches.length; a++) {
    for (let b = a + 1; b < matches.length; b++) {
      links.push({ originIndex: matches[a].routeIndex, destIndex: matches[b].routeIndex, depMin: matches[a].depMin });
    }
  }
  return links;
}

export const pairKey = (originIndex, destIndex) => `${originIndex}->${destIndex}`;

/**
 * Flatten a set of journeys onto one direction's stop list.
 *
 * @param {Array<{ operatorName: string, lineName: string, direction?: string, stops: Array<{ atco, depMin }>, [k: string]: any }>} journeys
 * @param {string[]} routeStopIds
 * @param {{ aliases?: Record<string, number> }} [opts]
 * @returns {{
 *   timelines: Map<string, Array<{ depMin: number, service: string }>>,   // pairKey → departures at origin
 *   retained: Array<{ journey: object, matches: Array }>,
 *   services: Map<string, { operator: string, line: string, direction: string, journeys: number, stopIndices: Set<number> }>,
 *   stopDepartures: number[],           // per route index: retained departures going on to a later route stop
 *   toleranceMatches: number,           // matched stops that needed the alias table
 *   dropped: number                     // journeys touching only one route stop (no OD pair served)
 * }}
 */
export function flattenJourneys(journeys, routeStopIds, opts = {}) {
  const matcher = buildStopMatcher(routeStopIds, opts.aliases ?? {});
  const timelines = new Map();
  const services = new Map();
  const retained = [];
  const stopDepartures = new Array(routeStopIds.length).fill(0);
  let toleranceMatches = 0, dropped = 0;

  for (const j of journeys) {
    const matches = matchJourney(j.stops, matcher);
    if (matches.length < 2 || !sharesVector(matches)) { if (matches.length) dropped++; continue; }
    retained.push({ journey: j, matches });
    toleranceMatches += matches.filter((m) => m.viaTolerance).length;
    const label = serviceLabel(j);
    const key = `${label}|${j.direction ?? ""}`;
    const svc = services.get(key) ?? { operator: j.operatorName, noc: j.operatorNoc, line: j.lineName, direction: j.direction ?? "", journeys: 0, stopIndices: new Set() };
    svc.journeys++;
    for (const m of matches) svc.stopIndices.add(m.routeIndex);
    services.set(key, svc);
    for (let a = 0; a < matches.length - 1; a++) stopDepartures[matches[a].routeIndex]++;
    for (const l of journeyLinks(matches)) {
      const k = pairKey(l.originIndex, l.destIndex);
      if (!timelines.has(k)) timelines.set(k, []);
      timelines.get(k).push({ depMin: l.depMin, service: label });
    }
  }
  for (const t of timelines.values()) t.sort((a, b) => a.depMin - b.depMin);
  return { timelines, retained, services, stopDepartures, toleranceMatches, dropped };
}

/** "Operator LineName" as written into supplyVector.detectedOverlappingLines. */
export const serviceLabel = (j) => `${(j.operatorName || j.operatorNoc || "?").trim()} ${(j.lineName || "").trim()}`.trim();

/**
 * Chain sectional registrations into through journeys.
 *
 * Long routes are often registered (and published to BODS) in sections — Arriva's X15 Newcastle–Berwick
 * is three services: Newcastle–Morpeth, Morpeth–Alnwick, Alnwick–Berwick — although one vehicle runs
 * through and passengers ride across the join. Without chaining, a pair such as Morpeth → Berwick
 * would show no supply. Two journeys of the same operator and line are joined when the second starts
 * where (or within `junctionRadiusM` of where) the first ends, departs within `maxWaitMin` of the
 * first's arrival, and continues in roughly the same direction (the bearing of its stop sequence is
 * within `maxTurnDeg` of the first's), which rejects the return working leaving the same bus station.
 *
 * @param {Array} journeys  expanded journeys (same operating day)
 * @param {{ coordsOf: (atco: string) => { lat: number, lng: number } | undefined, maxWaitMin?: number, junctionRadiusM?: number, maxTurnDeg?: number }} opts
 * @returns {{ journeys: Array, chains: number, segmentsJoined: number }}
 */
export function chainJourneys(journeys, opts) {
  const coordsOf = opts?.coordsOf ?? (() => undefined);
  const maxWait = opts?.maxWaitMin ?? 20;
  const radius = opts?.junctionRadiusM ?? 150;
  const maxTurn = opts?.maxTurnDeg ?? 90;

  const sorted = [...journeys].sort((a, b) => a.departureMin - b.departureMin);
  const consumed = new Set();
  const out = [];
  let chains = 0, segmentsJoined = 0;

  const last = (j) => j.stops[j.stops.length - 1];
  const heading = (j) => {
    const a = coordsOf(j.stops[0].atco), b = coordsOf(last(j).atco);
    return a && b ? bearing(a, b) : null;
  };
  const sameGroup = (a, b) => a.operatorNoc === b.operatorNoc && a.lineName === b.lineName;
  const joins = (tail, next) => {
    if (tail.stops.some((s) => s.atco === next.stops[0].atco) && last(tail).atco !== next.stops[0].atco) return false;
    const end = last(tail), start = next.stops[0];
    if (start.atco !== end.atco) {
      const a = coordsOf(end.atco), b = coordsOf(start.atco);
      if (!a || !b || distanceM(a, b) > radius) return false;
    }
    const wait = start.depMin - end.arrMin;
    if (wait < 0 || wait > maxWait) return false;
    const h1 = heading(tail), h2 = heading(next);
    if (h1 !== null && h2 !== null && angularDiff(h1, h2) > maxTurn) return false;
    return true;
  };

  for (let i = 0; i < sorted.length; i++) {
    if (consumed.has(i)) continue;
    let chain = { ...sorted[i], stops: [...sorted[i].stops], segments: [sorted[i].source ? `${sorted[i].source}#${sorted[i].journeyCode}` : sorted[i].journeyCode] };
    let extended = true;
    while (extended) {
      extended = false;
      let best = -1;
      for (let k = i + 1; k < sorted.length; k++) {
        if (consumed.has(k) || !sameGroup(chain, sorted[k])) continue;
        if (sorted[k].departureMin > last(chain).arrMin + maxWait) break;
        if (joins(chain, sorted[k]) && (best === -1 || sorted[k].departureMin < sorted[best].departureMin)) best = k;
      }
      if (best !== -1) {
        const next = sorted[best];
        const skipFirst = next.stops[0].atco === last(chain).atco ? 1 : 0;
        if (skipFirst) chain.stops[chain.stops.length - 1] = { ...last(chain), depMin: next.stops[0].depMin };
        chain.stops.push(...next.stops.slice(skipFirst));
        chain.segments.push(next.source ? `${next.source}#${next.journeyCode}` : next.journeyCode);
        consumed.add(best);
        segmentsJoined++;
        extended = true;
      }
    }
    if (chain.segments.length > 1) chains++;
    out.push(chain);
  }
  return { journeys: out, chains, segmentsJoined };
}

const toRad = (d) => (d * Math.PI) / 180;
function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
function angularDiff(a, b) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}
function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(s));
}

/**
 * Remove journeys that are exact duplicates (same operator, line, departure and stop/time sequence),
 * which happens when BODS carries two files for the same service (e.g. a superseded and a current
 * revision, both with open-ended operating periods).
 */
export function dedupeJourneys(journeys) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const j of journeys) {
    const key = [j.operatorNoc, j.lineName, j.direction, Math.round(j.departureMin), j.stops.map((s) => `${s.atco}@${Math.round(s.depMin)}`).join(",")].join("|");
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    out.push(j);
  }
  return { journeys: out, duplicates };
}
