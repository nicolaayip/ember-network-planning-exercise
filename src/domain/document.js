/**
 * Construction of the FlexibleRouteOptimizationDocument skeleton.
 *
 * Pure functions, no I/O. `buildEmptyDocument` produces a document that already
 * satisfies DATA_SCHEMA.json with every metric zeroed; pipeline steps then fill it in.
 *
 * Shape (DESIGN_DOC §2.1, §6): two directed services (outbound, return), each with its
 * own ordered stop list and directional OD pairs, plus timetable columns (one per driver
 * return trip). `mode` is "evaluate" when columns are supplied, "propose" otherwise.
 */

import { fallbackTemporalWindows } from "./temporal-windows.js";

export const DIRECTIONS = ["outbound", "return"];

const HHMM = /^[0-2][0-9]:[0-5][0-9]$/;
const ROLES = ["passenger", "depot"];

/** True for the depot point (first of outbound / last of return): routed and timed, never a calling point. */
export const isDepot = (stop) => stop?.role === "depot";
export const isPassenger = (stop) => !isDepot(stop);
/** Far-end terminal where the driver layover (≥ 45 min) sits — first passenger stop on return. */
export const layoverStopId = (dir, directionName) => {
  const pax = passengerStops(dir);
  return directionName === "return" && pax.length ? pax[0].naptanId : null;
};
/** Passenger dwell at departure (§2.4): all calling points except depot and the return layover stop. */
export const schedulingDwellSeconds = (stop, { directionName, layoverStopId: layoverId } = {}) => {
  if (!stop || isDepot(stop)) return 0;
  if (directionName === "return" && layoverId && stop.naptanId === layoverId) return 0;
  return stop.dwellTimeBufferSeconds ?? 0;
};
/** Dwell before a leg leaves its from-stop; dead legs carry no passenger dwell. */
export const legDepartureDwellSeconds = (leg, fromStop, ctx) =>
  leg?.deadLeg ? 0 : schedulingDwellSeconds(fromStop, ctx);
/** Passenger stops of a direction, in route order (excludes the depot). */
export const passengerStops = (dir) => dir.orderedStops.filter(isPassenger);

/** Deterministic id for a directional OD pair. */
export const pairId = (originStopId, destinationStopId) =>
  `${originStopId}->${destinationStopId}`;

/** Slug used when the caller does not supply a routeId. */
export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "route";

/**
 * Normalise a caller-supplied stop into the schema's stop shape.
 * Only `naptanId` is required at this stage; Step 1 (NaPTAN lookup) fills the rest.
 *
 * @param {object} stop
 * @param {number} index  zero-based position in the direction's stop list
 * @param {{ dwellTimeBufferSeconds: number }} defaults
 * @param {string} direction  for error messages
 */
export function normaliseStop(stop, index, defaults, direction = "") {
  const where = `${direction ? direction + "." : ""}stops[${index}]`;
  if (!stop || typeof stop.naptanId !== "string" || stop.naptanId.trim() === "") {
    throw new TypeError(`${where} must have a non-empty string naptanId`);
  }
  const lat = stop.coordinates?.lat;
  const lng = stop.coordinates?.lng;
  if (stop.role !== undefined && !ROLES.includes(stop.role)) {
    throw new TypeError(`${where}.role must be one of ${ROLES.join(", ")}`);
  }
  if (stop.role === "depot" && !(Number.isFinite(lat) && Number.isFinite(lng))) {
    throw new TypeError(`${where} is the depot and must carry coordinates (it is not in NaPTAN)`);
  }
  return {
    sequenceOrder: index,
    naptanId: stop.naptanId.trim(),
    ...(stop.role === "depot" ? { role: "depot" } : {}),
    stopName: stop.stopName ?? stop.naptanId.trim(),
    ...(stop.localityName ? { localityName: stop.localityName } : {}),
    coordinates: {
      lat: Number.isFinite(lat) ? lat : 0,
      lng: Number.isFinite(lng) ? lng : 0,
    },
    // Reserved per-leg flags (§7.11, §7.12): passed through if supplied, not used by the model.
    ...(typeof stop.isSingleCarriageway === "boolean" ? { isSingleCarriageway: stop.isSingleCarriageway } : {}),
    ...(stop.carriagewayKind === "urban" || stop.carriagewayKind === "single" || stop.carriagewayKind === "dual"
      ? { carriagewayKind: stop.carriagewayKind }
      : {}),
    ...(typeof stop.hasBusLane === "boolean" ? { hasBusLane: stop.hasBusLane } : {}),
    // Depot carries no passenger dwell; all calling points inherit the default unless overridden.
    dwellTimeBufferSeconds:
      stop.role === "depot"
        ? 0
        : Number.isInteger(stop.dwellTimeBufferSeconds)
          ? stop.dwellTimeBufferSeconds
          : defaults.dwellTimeBufferSeconds,
    ...(typeof stop.alwaysServed === "boolean" ? { alwaysServed: stop.alwaysServed } : {}),
    ...(Array.isArray(stop.proposedTimes) ? { proposedTimes: stop.proposedTimes.map(assertHHMM(`${where}.proposedTimes`)) } : {}),
  };
}

const assertHHMM = (label) => (v, i) => {
  if (typeof v !== "string" || !HHMM.test(v)) throw new TypeError(`${label}[${i}] must be HH:MM, got ${JSON.stringify(v)}`);
  return v;
};

/** Zeroed demand vector matching schema `demandVector`. */
export function emptyDemandVector() {
  return {
    offPeakWeekday: {
      proportionalRetainedPopulation: 0,
      destinationPoiGravityScore: 0,
      calculatedWeekdayGravityPotential: 0,
    },
    offPeakWeekend: {
      proportionalRawResidentPopulation: 0,
      destinationPoiWeekendGravityScore: 0,
      calculatedWeekendGravityPotential: 0,
    },
  };
}

/** Empty supply vector matching schema `supplyVector`. */
export function emptySupplyVector() {
  return { detectedOverlappingLines: [], calculatedHeadwayGaps: [], competitorDepartures: [] };
}

/**
 * All directional pairs (originIndex < destIndex) for one direction's ordered stop
 * list, in route order. n passenger stops -> n(n-1)/2 pairs; the depot has no pairs.
 */
export function buildDirectionalPairs(orderedStops) {
  const pax = orderedStops.filter(isPassenger);
  const pairs = [];
  for (let i = 0; i < pax.length; i++) {
    for (let j = i + 1; j < pax.length; j++) {
      const o = pax[i].naptanId;
      const d = pax[j].naptanId;
      pairs.push({
        pairId: pairId(o, d),
        originStopId: o,
        destinationStopId: d,
        simulatedTravelTimeMinutes: 0,
        demandVector: emptyDemandVector(),
        supplyVector: emptySupplyVector(),
      });
    }
  }
  return pairs;
}

/**
 * Build one direction from its input `{ label?, stops }`.
 */
export function buildDirection(input, engine, name) {
  if (!input || !Array.isArray(input.stops) || input.stops.length < 2) {
    throw new TypeError(`directions.${name}.stops must be an array of at least 2 stops`);
  }
  const orderedStops = input.stops.map((s, i) => normaliseStop(s, i, engine, name));
  const ids = new Set(orderedStops.map((s) => s.naptanId));
  if (ids.size !== orderedStops.length) {
    throw new TypeError(`directions.${name}.stops must not contain duplicate naptanIds`);
  }
  if (orderedStops.filter(isPassenger).length < 2) {
    throw new TypeError(`directions.${name}.stops must contain at least 2 passenger stops`);
  }
  // The depot may only be the first point (outbound) or the last (return): it is where the vehicle
  // comes from / goes back to, not a calling point in the middle of the run.
  const depotIdx = orderedStops.findIndex(isDepot);
  if (depotIdx !== -1) {
    const allowed = name === "return" ? orderedStops.length - 1 : 0;
    if (depotIdx !== allowed || orderedStops.filter(isDepot).length > 1) {
      throw new TypeError(`directions.${name}.stops: the depot must be the ${name === "return" ? "last" : "first"} point and appear once`);
    }
  }
  return {
    ...(input.label ? { label: input.label } : {}),
    orderedStops,
    directionalODPairs: buildDirectionalPairs(orderedStops),
  };
}

/**
 * Normalise caller-supplied timetable columns. Each is `{ outboundDeparture, returnDeparture }`
 * in HH:MM; ids are assigned in order if absent.
 */
export function normaliseColumns(columns) {
  if (columns === undefined || columns === null) return [];
  if (!Array.isArray(columns)) throw new TypeError("timetableColumns must be an array");
  return columns.map((c, i) => {
    for (const key of ["outboundDeparture", "returnDeparture"]) {
      if (typeof c?.[key] !== "string" || !HHMM.test(c[key])) {
        throw new TypeError(`timetableColumns[${i}].${key} must be HH:MM`);
      }
    }
    for (const key of ["depotDeparture", "depotArrival"]) {
      if (c[key] !== undefined && (typeof c[key] !== "string" || !HHMM.test(c[key]))) {
        throw new TypeError(`timetableColumns[${i}].${key} must be HH:MM`);
      }
    }
    return {
      columnId: c.columnId ?? `C${String(i + 1).padStart(2, "0")}`,
      outboundDeparture: c.outboundDeparture,
      returnDeparture: c.returnDeparture,
      ...(c.depotDeparture ? { depotDeparture: c.depotDeparture } : {}),
      ...(c.depotArrival ? { depotArrival: c.depotArrival } : {}),
    };
  });
}

/**
 * Build a schema-valid document with all metrics zeroed.
 *
 * @param {{ routeId?: string, routeName: string,
 *           directions: { outbound: { label?: string, stops: object[] }, return: { label?: string, stops: object[] } },
 *           timetableColumns?: Array<{ columnId?: string, outboundDeparture: string, returnDeparture: string }> }} input
 * @param {{ dwellTimeBufferSeconds: number, fallbackTemporalWindows: object }} engine  config.engine
 */
export function buildEmptyDocument(input, engine) {
  if (!input || typeof input.routeName !== "string" || input.routeName.trim() === "") {
    throw new TypeError("routeName is required");
  }
  if (!input.directions || typeof input.directions !== "object") {
    throw new TypeError("directions { outbound, return } is required");
  }

  const directions = {};
  for (const name of DIRECTIONS) directions[name] = buildDirection(input.directions[name], engine, name);

  const timetableColumns = normaliseColumns(input.timetableColumns);

  return {
    routeId: input.routeId?.trim() || slugify(input.routeName),
    routeName: input.routeName.trim(),
    mode: timetableColumns.length > 0 ? "evaluate" : "propose",
    ...(input.daysOfOperation !== undefined ? { daysOfOperation: input.daysOfOperation } : {}),
    estimatedTemporalWindows: fallbackTemporalWindows(engine.fallbackTemporalWindows),
    directions,
    timetableColumns,
  };
}

/** Iterate every OD pair across both directions. */
export function* allPairs(document) {
  for (const name of DIRECTIONS) {
    for (const pair of document.directions[name].directionalODPairs) yield { direction: name, pair };
  }
}
