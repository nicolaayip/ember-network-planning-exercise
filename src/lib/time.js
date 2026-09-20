/**
 * Service-day time helpers. Times are minutes from 00:00 of the operating day and may
 * exceed 1440 for the following morning (HH:MM notation "25:22" = 01:22 next day).
 */

const HHMM = /^(\d{1,2}):([0-5]\d)$/;

/** "07:15" -> 435; "25:22" -> 1522 */
export function parseHHMM(s) {
  const m = HHMM.exec(String(s).trim());
  if (!m) throw new TypeError(`Expected HH:MM, got ${JSON.stringify(s)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 435 -> "07:15"; 1522 -> "25:22" (service-day notation preserved) */
export function formatHHMM(minutes) {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 435 -> "07:15"; 1522 -> "01:22 (+1)" — for human-facing tables */
export function formatClock(minutes) {
  const m = Math.round(minutes);
  const day = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}${day > 0 ? ` (+${day})` : ""}`;
}

/** 202 -> "3h22" */
export function formatDuration(minutes) {
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
