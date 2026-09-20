/**
 * Central configuration — canonical source for all non-secret parameters.
 *
 * Edit values here. `.env` is for API keys, credentials, and runtime mode only
 * (MOCK, LOG_LEVEL). Nothing else in src/ should read process.env directly.
 */

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
};
const envBool = (key, fallback) => String(env(key, fallback)).toLowerCase() === "true";

export const config = Object.freeze({
  root: ROOT,

  mock: envBool("MOCK", false),
  logLevel: env("LOG_LEVEL", "info"),

  paths: Object.freeze({
    cache: path.resolve(ROOT, "./cache"),
    output: path.resolve(ROOT, "./output"),
    fixtures: path.resolve(ROOT, "./fixtures"),
    data: path.resolve(ROOT, "./data"),
    schema: path.join(ROOT, ".cursor", "DATA_SCHEMA.json"),
  }),

  keys: Object.freeze({
    google: env("GOOGLE_MAPS_API_KEY", ""),
    openRouteService: env("OPENROUTESERVICE_API_KEY", ""),
    bods: env("BODS_API_KEY", ""),
    tndsUsername: env("TNDS_USERNAME", ""),
    tndsPassword: env("TNDS_PASSWORD", ""),
  }),

  engine: Object.freeze({
    // Dwell buffer at each passenger departure (DESIGN_DOC §2.4; brief range 60–90 s).
    dwellTimeBufferSeconds: 75,
    // Corridor-wide multiplier on Google's car `duration` (DESIGN_DOC §2.3). Central blends the
    // 50 mph single-carriageway penalty over ~3/4 of the A1 with unpenalised dual carriageway.
    coachTimeFactor: Object.freeze({
      low: 1.0,
      central: 1.15,
      high: 1.25,
    }),
    /** Flag OD pairs where coachPathKm / directCarKm exceeds this (DESIGN_DOC §2.3). */
    pathDetourWarnRatio: 1.25,
    headwayGapThresholdMinutes: 60,
    isochroneWalkSeconds: 600,
    fallbackTemporalWindows: Object.freeze({
      weekdayBands: Object.freeze([
        Object.freeze({ id: "peak1", kind: "peak", start: "07:30", end: "10:30", apex: "07:30" }),
        Object.freeze({ id: "valley1", kind: "valley", start: "10:30", end: "16:30", apex: "13:00" }),
        Object.freeze({ id: "peak2", kind: "peak", start: "16:30", end: "19:00", apex: "16:30" }),
      ]),
      weekendDeparture: "11:00",
    }),
  }),

  // §1.4 temporal windows from WebTRIS (England SRN)
  traffic: Object.freeze({
    // Pin seasonal WebTRIS windows so cache keys stay stable across re-runs (today + leadDays otherwise).
    referenceDate: "2026-09-16",
    launchLeadDays: 70,
    windowMonths: 3,
    historyYears: 3,
    periodStart: "",
    weeks: 4,
    excludeChristmas: true,
    bankHolidays: Object.freeze([
      "2023-01-02", "2023-04-07", "2023-04-10", "2023-05-01", "2023-05-08", "2023-05-29", "2023-08-28", "2023-12-25", "2023-12-26",
      "2024-01-01", "2024-03-29", "2024-04-01", "2024-05-06", "2024-05-27", "2024-08-26", "2024-12-25", "2024-12-26",
      "2025-01-01", "2025-04-18", "2025-04-21", "2025-05-05", "2025-05-26", "2025-08-25", "2025-12-25", "2025-12-26",
      "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
    ]),
    siteRadiusM: 3000,
    roadRegex: "\\bA1\\b|A1\\(M\\)",
    minCoverage: 0.75,
  }),

  supply: Object.freeze({
    adminAreas: Object.freeze([410, 310, 690]),
    stopToleranceM: 50,
    dayStartMin: 300,
    dayEndMin: 1380,
    includeSchoolDayJourneys: false,
    includeCoachZip: true,
    chainMaxWaitMin: 20,
    chainJunctionRadiusM: 150,
    referenceDate: undefined,
    tndsScotlandZip: undefined,
  }),

  selection: Object.freeze({
    gridStartMin: 300,
    gridEndMin: 1260,
    gridStepMin: 15,
    layoversMin: Object.freeze([45, 60, 75, 90]),
    maxColumns: 12,
    minMarginalGain: 0.005,
    minSpacingMin: 60,
    /** Stop gap-hit selection when the best remaining slot adds fewer pair hits than this. */
    minNewGapHits: 5,
  }),

  fleet: Object.freeze({
    vehicle: Object.freeze({
      model: "Yutong GTe14",
      batteryKwh: 621,
      maxChargePowerKw: 600,
      socFloor: 0.1,
    }),
    consumptionKwhPerKm: Object.freeze({ low: 1.0, central: 1.25, high: 1.5 }),
    site: Object.freeze({
      cables: 4,
      cablePowerKw: 180,
      maxCablesPerVehicle: 2,
      plugHandlingMinutes: 10,
    }),
    driversHours: Object.freeze({
      maxContinuousDrivingMinutes: 270,
      maxContinuousWorkingMinutes: 360,
      minBreakMinutes: 45,
      maxDailyDrivingMinutes: 540,
    }),
    depotToChargerKm: 0,
    recommendedFleetCap: undefined,
    slotMinutes: 15,
  }),

  endpoints: Object.freeze({
    googleRoutes: "https://routes.googleapis.com/directions/v2:computeRoutes",
    googleRouteMatrix: "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
    openRouteServiceIsochrones: "https://api.openrouteservice.org/v2/isochrones/foot-walking",
    overpass: "https://overpass.openstreetmap.fr/api/interpreter",
    overpassMirrors: Object.freeze([
      "https://overpass.openstreetmap.fr/api/interpreter",
      "https://overpass-api.de/api/interpreter",
      "https://lz4.overpass-api.de/api/interpreter",
    ]),
    webtris: "https://webtris.nationalhighways.co.uk/api/v1",
    onsLsoaBoundaries:
      "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Lower_layer_Super_Output_Areas_December_2021_Boundaries_EW_BGC_V5/FeatureServer/0",
    scotGovDataZoneBoundaries:
      "https://maps.gov.scot/server/rest/services/ScotGov/StatisticalUnits/MapServer/10",
    bods: "https://data.bus-data.dft.gov.uk/api/v1",
  }),
});

export default config;
