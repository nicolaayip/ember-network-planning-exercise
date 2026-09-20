/**
 * Build the §6.7 assumptions register from config — stamped on every engine run
 * so scenarios and the dashboard share the same parameter provenance as config.js.
 *
 * @format
 */

/** @param {import("../config.js").config} cfg */
export function buildAssumptionsRegister(cfg) {
  const e = cfg.engine;
  const f = cfg.fleet;
  return [
    {
      key: "dwellTimeBufferSeconds",
      parameter: "Dwell buffer per stop",
      value: e.dwellTimeBufferSeconds,
      unit: "s",
      source: "config",
      section: "§2.4",
      note: "Schedule recovery at each passenger departure; depot and return layover carry zero.",
    },
    {
      key: "coachTimeFactor",
      parameter: "Coach time factor (fallback when leg untagged)",
      value: e.coachTimeFactor.central,
      low: e.coachTimeFactor.low,
      high: e.coachTimeFactor.high,
      source: "config",
      section: "§2.3",
      note: "Per-leg factors from OSM: urban x1.0, single x1.2 (50/60 mph), dual x1.17 (60/70 mph), Ember >12 m. Fallback only.",
    },
    {
      key: "pathDetourWarnRatio",
      parameter: "Path detour warning threshold",
      value: e.pathDetourWarnRatio,
      source: "config",
      section: "§2.3",
      note: "OD pair flagged when coachPathKm / directCarKm exceeds this ratio.",
    },
    {
      key: "headwayGapThresholdMinutes",
      parameter: "Market opening headway threshold",
      value: e.headwayGapThresholdMinutes,
      unit: "min",
      source: "config",
      section: "§4.4",
      note: "Interior BODS gap must overlap a WebTRIS peak band by at least this many minutes; edge gaps excluded.",
    },
    {
      key: "isochroneWalkSeconds",
      parameter: "Walk catchment radius",
      value: e.isochroneWalkSeconds / 60,
      unit: "min",
      source: "config",
      section: "§3.2",
      note: "OpenRouteService foot-walking isochrone.",
    },
    {
      key: "consumptionKwhPerKm",
      parameter: "Energy consumption",
      value: f.consumptionKwhPerKm.central,
      unit: "kWh/km",
      low: f.consumptionKwhPerKm.low,
      high: f.consumptionKwhPerKm.high,
      source: "config",
      section: "§5.2",
    },
    {
      key: "driversHours",
      parameter: "Drivers' hours",
      value: "≤ 4 h 30 continuous, ≥ 45 min break, ≤ 9 h daily",
      source: "Assimilated EU Regulation 561/2006",
      section: "§5.4",
    },
  ];
}
