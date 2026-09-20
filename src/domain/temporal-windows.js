/**
 * Per-direction weekday traffic windows (§1.4).
 * `estimatedTemporalWindows` holds outbound and return band lists from WebTRIS.
 */

export { SERVICE_DIRECTIONS } from "./traffic-bands.js";
export { weekdayBands, weekendDeparture, fallbackTemporalWindows } from "./traffic-bands.js";

const isoDate = (d) => d.toISOString().slice(0, 10);

/** Estimated service launch (today + lead days), YYYY-MM-DD UTC calendar date (§1.4). */
export function estimatedLaunchDate(today = new Date(), leadDays = 70) {
  const launch = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + leadDays));
  return isoDate(launch);
}

/** Human-readable WebTRIS sample window — derived in UI/exports, not stored on the document. */
export function trafficSamplePeriodLabel(period) {
  if (!period) return "Season-aligned WebTRIS window";
  if (period.label) return period.label;
  if (period.windowMonths != null && period.launchLeadDays != null) {
    return `Est. launch +${period.launchLeadDays} d · ${period.windowMonths}-mo season`;
  }
  const w = period.windows?.[0];
  if (w?.start && w?.end) return `${w.start} – ${w.end}`;
  return "Season-aligned WebTRIS window";
}
