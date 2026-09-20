/** @format */

import type { DirectionName, ReferencePin, Stop } from "../types";

/** The depot appears in the KMZ as a placemark in each layer but is not a passenger stop. */
export const isDepotPin = (p: ReferencePin): boolean => /depot|garage/i.test(p.name);

/** Pin within this many metres of the NaPTAN stop = on-stop match for display. */
export const SAME_KERB_M = 8;

/** NaPTAN stop within this many metres of the KMZ placemark = aligned for the stops table. */
export const KMZ_ALIGN_M = 5;

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function metres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = rad(b.lat - a.lat),
    dLng = rad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** KMZ layer name → engine direction, when recognisable. */
export function pinDirection(pin: ReferencePin): DirectionName | null {
  const l = pin.layer.toLowerCase();
  if (/outbound|out\b|northbound/.test(l)) return "outbound";
  if (/return|inbound|back|southbound/.test(l)) return "return";
  return null;
}

export interface PinMatch {
  pin: ReferencePin;
  stop: Stop;
  metres: number;
}

/**
 * Pair each pin in a layer with the nearest stop of the corresponding direction.
 * A pin more than `maxM` from any stop is returned with stop = null. Depot pins are excluded.
 */
export function matchPins(
  pins: ReferencePin[],
  stops: Stop[],
  direction: DirectionName,
  maxM = 400,
): Array<PinMatch | { pin: ReferencePin; stop: null; metres: number }> {
  return pins
    .filter((p) => pinDirection(p) === direction && !isDepotPin(p))
    .map((pin) => {
      let best: Stop | null = null,
        bestM = Infinity;
      for (const s of stops) {
        if (s.role === "depot") continue;
        const m = metres(pin, s.coordinates);
        if (m < bestM) {
          bestM = m;
          best = s;
        }
      }
      return best && bestM <= maxM
        ? { pin, stop: best, metres: bestM }
        : { pin, stop: null, metres: bestM };
    });
}

/** For a stop, the nearest pin in the matching layer (any distance). */
export function nearestPin(
  stop: Stop,
  pins: ReferencePin[],
  direction: DirectionName,
): { pin: ReferencePin; metres: number } | null {
  let best: ReferencePin | null = null,
    bestM = Infinity;
  for (const p of pins) {
    if (pinDirection(p) !== direction || isDepotPin(p)) continue;
    const m = metres(p, stop.coordinates);
    if (m < bestM) {
      bestM = m;
      best = p;
    }
  }
  return best ? { pin: best, metres: bestM } : null;
}

/** MapLibre icon-rotate: degrees clockwise from north for a compass label. */
export function compassIconRotate(compass?: string): number {
  switch (compass?.toLowerCase()) {
    case "northbound":
      return 0;
    case "eastbound":
      return 90;
    case "southbound":
      return 180;
    case "westbound":
      return 270;
    default:
      return 0;
  }
}

/** Closest point on a polyline ([lng, lat] pairs) and distance in metres. */
export function nearestPointOnPolyline(
  point: { lat: number; lng: number },
  line: [number, number][],
): { point: [number, number]; metres: number } | null {
  if (line.length < 2) return null;
  let best: { point: [number, number]; metres: number } | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const [lng0, lat0] = line[i];
    const [lng1, lat1] = line[i + 1];
    for (let t = 0; t <= 1; t += 0.05) {
      const lat = lat0 + (lat1 - lat0) * t;
      const lng = lng0 + (lng1 - lng0) * t;
      const m = metres(point, { lat, lng });
      if (!best || m < best.metres) best = { point: [lng, lat], metres: m };
    }
  }
  return best;
}

/** Lat/lng pair for clipboard — matches map popups (`lat,lng`, 5 dp). */
export function formatLatLng(c: { lat: number; lng: number }, digits = 5): string {
  return `${c.lat.toFixed(digits)},${c.lng.toFixed(digits)}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}
