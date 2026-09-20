export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function num(v: unknown, digits = 0, fallback = "–"): string {
  if (!isNum(v)) return fallback;
  return v.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function pct(v: unknown, digits = 0): string {
  return isNum(v) ? `${(v * 100).toFixed(digits)}%` : "–";
}

/** Minutes → "3 h 37 min" / "45 min". */
export function duration(min: unknown): string {
  if (!isNum(min)) return "–";
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

/** Service-day minutes → "HH:MM" with "(+1)" after midnight. */
export function clock(min: unknown): string {
  if (!isNum(min)) return "–";
  const m = Math.round(min);
  const h = Math.floor(m / 60), mm = m % 60;
  const hh = String(h % 24).padStart(2, "0");
  return `${hh}:${String(mm).padStart(2, "0")}${h >= 24 ? " (+1)" : ""}`;
}

/** Service-day "HH:MM" (may exceed 24h, e.g. "28:42") → "04:42⁺" for tables. */
export function displayServiceTime(s: string | undefined | null): string {
  if (!s) return "–";
  const mins = parseHHMM(s);
  if (mins == null) return "–";
  return clock(mins).replace(" (+1)", "⁺");
}

/** "HH:MM" (service-day, may exceed 24) → minutes. */
export function parseHHMM(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function signed(v: unknown, digits = 0): string {
  if (!isNum(v)) return "–";
  const s = num(Math.abs(v), digits);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export const titleCase = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
