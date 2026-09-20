/**
 * Google Routes API v2 adapter (DESIGN_DOC §2.2).
 *
 * computeRoutes with travelMode DRIVE, routingPreference TRAFFIC_AWARE, the direction's stops as
 * origin / intermediates / destination, and a departureTime for the requested temporal window.
 * Returns per-leg distanceMeters, duration (traffic-aware) and staticDuration (free-flow).
 * Responses are cached to disk; MOCK=true serves from cache only.
 *
 * @format
 */

import { config } from "../config.js";
import { bandById, weekendDeparture, weekdayBands } from "../domain/traffic-bands.js";
import { estimatedLaunchDate } from "../domain/temporal-windows.js";
import { cached } from "../lib/cache.js";
import { http, withRetry, describeHttpError } from "../lib/http.js";

const FIELD_MASK = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.staticDuration",
  "routes.legs.distanceMeters",
  "routes.legs.duration",
  "routes.legs.staticDuration",
  "routes.polyline.encodedPolyline",
].join(",");

const MATRIX_FIELD_MASK = [
  "originIndex",
  "destinationIndex",
  "distanceMeters",
  "duration",
  "staticDuration",
  "status",
  "condition",
].join(",");

const parseSeconds = (s) => (s ? Number(String(s).replace(/s$/, "")) : 0);

/**
 * Launch date for Google departure anchoring: document traffic profile or config lead days.
 * @param {object} doc
 * @param {object} cfg
 * @param {Date} [now]
 */
export function resolveLaunchDate(doc, cfg, now = new Date()) {
  return (
    doc.trafficProfile?.period?.launchDate ??
    estimatedLaunchDate(now, cfg.traffic.launchLeadDays)
  );
}

/**
 * First `weekday` (0=Sun..6=Sat) at HH:MM Europe/London on or after `launchDate`, strictly after
 * `now` (Routes API rejects past departure times for TRAFFIC_AWARE). Without `launchDate`, scans
 * from today. Returns ISO string.
 * @param {string} hhmm
 * @param {number} weekday
 * @param {{ now?: Date, launchDate?: string | null }} [opts]
 */
export function nextDepartureIso(hhmm, weekday, opts = {}) {
  const { now = new Date(), launchDate = null } = opts;
  const [h, m] = hhmm.split(":").map(Number);
  const startMs = launchDate
    ? (() => {
        const [y, mo, da] = launchDate.split("-").map(Number);
        return Date.UTC(y, mo - 1, da);
      })()
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let d = 0; d <= 400; d++) {
    const cand = new Date(startMs + d * 86400_000);
    if (cand.getUTCDay() !== weekday) continue;
    const y = cand.getUTCFullYear(),
      mo = cand.getUTCMonth(),
      da = cand.getUTCDate();
    const probe = new Date(Date.UTC(y, mo, da, 12));
    const offsetMin = londonOffsetMinutes(probe);
    const iso = new Date(Date.UTC(y, mo, da, h, m) - offsetMin * 60_000);
    if (iso > now) return iso.toISOString();
  }
  throw new Error("could not find a future departure date");
}

/** Traffic-sample departure ISO anchored to estimated launch season when available. */
export function departureIso(hhmm, weekday, doc, cfg, now = new Date()) {
  const launchDate = resolveLaunchDate(doc, cfg, now);
  return nextDepartureIso(hhmm, weekday, { now, launchDate });
}

function londonOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-]\d{1,2})?(?::?(\d{2}))?/.exec(tz);
  if (!m || !m[1]) return 0;
  return Number(m[1]) * 60 + (m[2] ? Math.sign(Number(m[1])) * Number(m[2]) : 0);
}

/** Traffic sample id (band id or weekend) -> { hhmm, weekday } for a service direction. */
export function departureForSample(
  sampleId,
  temporalWindows,
  serviceDirection = "outbound",
) {
  const TUESDAY = 2,
    SATURDAY = 6;
  if (sampleId === "weekend")
    return {
      hhmm: weekendDeparture(temporalWindows, serviceDirection),
      weekday: SATURDAY,
    };
  const band = bandById(weekdayBands(temporalWindows, serviceDirection), sampleId);
  if (!band) throw new Error(`unknown traffic sample ${sampleId}`);
  return { hhmm: band.apex, weekday: TUESDAY };
}

/**
 * Compute a route through `stops` (array of { lat, lng }) departing at `departureIso`.
 * @returns {Promise<{ legs: Array<{ fromIndex: number, toIndex: number, distanceKm: number, durationMin: number, staticDurationMin: number }>, totalKm: number, totalMin: number, polyline?: string, departureIso: string, cached: boolean }>}
 */
export async function computeRoute(stops, departureIso, opts = {}) {
  if (stops.length < 2) throw new Error("computeRoute needs at least 2 stops");
  if (stops.length > 27)
    throw new Error(
      `computeRoute supports at most 25 intermediates (got ${stops.length - 2})`,
    );

  const toWp = (s) => ({
    location: { latLng: { latitude: s.lat, longitude: s.lng } },
    via: false,
  });
  const body = {
    origin: toWp(stops[0]),
    destination: toWp(stops.at(-1)),
    intermediates: stops.slice(1, -1).map(toWp),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    departureTime: departureIso,
    units: "METRIC",
    languageCode: "en-GB",
  };

  // Cache key: coordinates + weekday/time + launch anchor (season), not the absolute calendar date.
  const keyDate = new Date(departureIso);
  const key = {
    stops: stops.map((s) => [Number(s.lat.toFixed(6)), Number(s.lng.toFixed(6))]),
    weekday: keyDate.getUTCDay(),
    hhmmUtc: `${keyDate.getUTCHours()}:${keyDate.getUTCMinutes()}`,
    launchAnchor: opts.launchDate ?? "none",
  };

  const { value, cached: hit } = await cached("google-routes", key, async () => {
    if (!config.keys.google)
      throw new Error("GOOGLE_MAPS_API_KEY is not set (and no cached response exists)");
    try {
      const res = await withRetry(
        () =>
          http.post(config.endpoints.googleRoutes, body, {
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": config.keys.google,
              "X-Goog-FieldMask": FIELD_MASK,
            },
          }),
        { log: opts.log },
      );
      return res.data;
    } catch (err) {
      throw new Error(`Google Routes: ${describeHttpError(err)}`);
    }
  });

  const route = value.routes?.[0];
  if (!route)
    throw new Error(
      `Google Routes returned no route (${JSON.stringify(value).slice(0, 200)})`,
    );
  if (route.legs.length !== stops.length - 1) {
    throw new Error(
      `Google Routes returned ${route.legs.length} legs for ${stops.length} stops`,
    );
  }
  return {
    legs: route.legs.map((l, i) => ({
      fromIndex: i,
      toIndex: i + 1,
      distanceKm: (l.distanceMeters ?? 0) / 1000,
      durationMin: parseSeconds(l.duration) / 60,
      staticDurationMin: parseSeconds(l.staticDuration) / 60,
    })),
    totalKm: (route.distanceMeters ?? 0) / 1000,
    totalMin: parseSeconds(route.duration) / 60,
    polyline: route.polyline?.encodedPolyline,
    departureIso,
    cached: hit,
  };
}

const toMatrixWaypoint = (s) => ({
  waypoint: { location: { latLng: { latitude: s.lat, longitude: s.lng } } },
});

/**
 * Direct-drive distance and duration for every origin x destination pair (Google Route Matrix).
 * Billed per element; cache key is all coordinates + departure weekday/time.
 *
 * @param {Array<{ lat: number, lng: number }>} origins
 * @param {Array<{ lat: number, lng: number }>} destinations
 * @param {string} departureIso
 * @returns {Promise<{ elements: Array<{ originIndex: number, destinationIndex: number, distanceKm: number, durationMin: number, staticDurationMin: number }>, departureIso: string, cached: boolean }>}
 */
export async function computeRouteMatrix(origins, destinations, departureIso, opts = {}) {
  if (!origins.length || !destinations.length) {
    throw new Error("computeRouteMatrix needs at least one origin and one destination");
  }
  if (origins.length * destinations.length > 625) {
    throw new Error(
      `computeRouteMatrix supports at most 625 elements (got ${origins.length * destinations.length})`,
    );
  }

  const body = {
    origins: origins.map(toMatrixWaypoint),
    destinations: destinations.map(toMatrixWaypoint),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    departureTime: departureIso,
    units: "METRIC",
    languageCode: "en-GB",
  };

  const keyDate = new Date(departureIso);
  const key = {
    origins: origins.map((s) => [Number(s.lat.toFixed(6)), Number(s.lng.toFixed(6))]),
    destinations: destinations.map((s) => [
      Number(s.lat.toFixed(6)),
      Number(s.lng.toFixed(6)),
    ]),
    weekday: keyDate.getUTCDay(),
    hhmmUtc: `${keyDate.getUTCHours()}:${keyDate.getUTCMinutes()}`,
    launchAnchor: opts.launchDate ?? "none",
    fieldMask: MATRIX_FIELD_MASK,
  };

  const { value, cached: hit } = await cached("google-route-matrix-v2", key, async () => {
    if (!config.keys.google)
      throw new Error("GOOGLE_MAPS_API_KEY is not set (and no cached response exists)");
    try {
      const res = await withRetry(
        () =>
          http.post(config.endpoints.googleRouteMatrix, body, {
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": config.keys.google,
              "X-Goog-FieldMask": MATRIX_FIELD_MASK,
            },
          }),
        { log: opts.log },
      );
      return res.data;
    } catch (err) {
      throw new Error(`Google Route Matrix: ${describeHttpError(err)}`);
    }
  });

  const rows = Array.isArray(value) ? value : (value?.elements ?? []);
  const elements = [];
  for (const row of rows) {
    if (row.condition && row.condition !== "ROUTE_EXISTS") continue;
    if (row.status?.code) continue;
    const o = row.originIndex ?? row.origin_index;
    const d = row.destinationIndex ?? row.destination_index;
    if (o === undefined || d === undefined) continue;
    const staticRaw = row.staticDuration ?? row.duration;
    const staticDurationMin = Math.round((parseSeconds(staticRaw) / 60) * 10) / 10;
    if (!staticRaw) {
      throw new Error("Google Route Matrix element missing duration and staticDuration");
    }
    elements.push({
      originIndex: o,
      destinationIndex: d,
      distanceKm: Math.round(((row.distanceMeters ?? 0) / 1000) * 100) / 100,
      durationMin: Math.round((parseSeconds(row.duration) / 60) * 10) / 10,
      staticDurationMin,
    });
  }
  if (!elements.length) {
    throw new Error(
      `Google Route Matrix returned no usable elements (${JSON.stringify(value).slice(0, 200)})`,
    );
  }
  return { elements, departureIso, cached: hit };
}
