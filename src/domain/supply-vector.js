/** @format */

import { parseHHMM } from "../lib/time.js";

/** Competitor departure times (minutes) for a BODS day type from a pair supplyVector. */
export function competitorDeparturesMinutes(supplyVector, supplyDay) {
  const deps =
    supplyDay === "saturday"
      ? supplyVector?.saturdayCompetitorDepartures
      : supplyVector?.competitorDepartures;
  return (deps ?? []).map((d) => parseHHMM(d.time)).filter((t) => t != null);
}
