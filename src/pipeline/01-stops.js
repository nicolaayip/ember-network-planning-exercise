/**
 * Step 1 — INPUT (DESIGN_DOC §2.1, flow step 1).
 *
 * Resolves every stop against NaPTAN by ATCO code: fills stopName / localityName / coordinates
 * where the input left them out, reprojecting Easting/Northing where NaPTAN has no lat/lng.
 *
 * @format
 */

import { loadNaptan } from "../adapters/naptan.js";
import { DIRECTIONS, isDepot } from "../domain/document.js";

export const name = "stops";

// The depot is not in NaPTAN: it arrives with coordinates (enforced by normaliseStop) and is never looked up.
const needsLookup = (s) =>
  !isDepot(s) &&
  ((s.coordinates.lat === 0 && s.coordinates.lng === 0) || s.stopName === s.naptanId);

export async function run(ctx) {
  const { document: doc, log } = ctx;
  const pending = [];
  for (const d of DIRECTIONS)
    for (const s of doc.directions[d].orderedStops) if (needsLookup(s)) pending.push(s);
  if (pending.length === 0) {
    log.debug("all stops already resolved");
    return ctx;
  }

  const naptan = ctx.naptan ?? (ctx.naptan = await loadNaptan({ log }));
  const missing = [];
  for (const s of pending) {
    const n = naptan.get(s.naptanId);
    if (!n) {
      missing.push(s.naptanId);
      continue;
    }
    if (s.stopName === s.naptanId)
      s.stopName = n.indicator ? `${n.name} (${n.indicator})` : n.name;
    if (!s.localityName && n.locality) s.localityName = n.locality;
    if (s.coordinates.lat === 0 && s.coordinates.lng === 0)
      s.coordinates = { lat: n.lat, lng: n.lng };
  }
  if (missing.length)
    throw new Error(
      `NaPTAN codes not found (active bus stops only): ${missing.join(", ")}`,
    );
  log.info({ resolved: pending.length }, "stops resolved from NaPTAN");
  return ctx;
}
