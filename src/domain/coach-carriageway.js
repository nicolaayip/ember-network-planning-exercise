/**
 * Per-leg coach speed factors from carriageway kind (Ember >12 m coaches).
 * urban 30/30 mph, single 50/60, dual/motorway 60/70.
 */

export const COACH_FACTORS = Object.freeze({
  urban: 1,
  single: 1.2,
  dual: 70 / 60,
});

/** @param {Record<string, string>|undefined} tags */
export function classifyOsmWay(tags = {}) {
  if (tags.highway === "motorway" || tags.highway === "motorway_link") return "dual";
  if (tags.dual_carriageway === "yes") return "dual";
  if (tags.dual_carriageway === "no") return "single";
  if (tags.maxspeed === "70 mph" || tags.expressway === "yes") return "dual";
  if (tags.maxspeed === "60 mph" && /\bA1\b|A1\(M\)/i.test(`${tags.ref ?? ""}`)) return "single";
  return null;
}

/** Plurality of classified trunk/motorway ways; no hits → urban. */
export function dominantKind(elements) {
  const counts = { urban: 0, single: 0, dual: 0 };
  for (const el of elements) {
    const t = el.tags ?? {};
    if (!/^(motorway|trunk|motorway_link|trunk_link)$/.test(t.highway ?? "")) continue;
    const kind = classifyOsmWay(t) ?? "single";
    counts[kind] += 1;
  }
  if (!counts.single && !counts.dual) return "urban";
  return counts.dual >= counts.single ? "dual" : "single";
}

/** @param {"urban"|"single"|"dual"|undefined|null} kind @param {number} fallback */
export function coachFactorForKind(kind, fallback = COACH_FACTORS.single) {
  if (kind && kind in COACH_FACTORS) return COACH_FACTORS[kind];
  return fallback;
}

/** Traffic-aware coach minutes: factor on static only, congestion unchanged. */
export function coachLegMin(window, factor) {
  const duration = Number(window?.durationMin);
  const staticMin = Number(window?.staticDurationMin);
  if (!Number.isFinite(duration) || !Number.isFinite(staticMin) || !Number.isFinite(factor)) return null;
  const congestion = Math.max(0, duration - staticMin);
  return Math.round((staticMin * factor + congestion) * 10) / 10;
}

/** Free-flow coach minutes for one leg. */
export function coachStaticMin(window, factor) {
  const staticMin = Number(window?.staticDurationMin);
  if (!Number.isFinite(staticMin) || !Number.isFinite(factor)) return null;
  return Math.round(staticMin * factor * 10) / 10;
}

/**
 * Sum coach free-flow minutes for a leg list. Each leg may be a topology window
 * ({ windows: { [sample]: { staticDurationMin } } }) or a skip-stop route leg
 * ({ staticDurationMin }).
 */
export function sumCoachStaticMin(legs, factors, sampleId) {
  if (!legs?.length || legs.length !== factors.length) return null;
  let total = 0;
  for (let i = 0; i < legs.length; i++) {
    const staticMin =
      legs[i].staticDurationMin ?? legs[i].windows?.[sampleId]?.staticDurationMin;
    const m = coachStaticMin({ staticDurationMin: staticMin }, factors[i]);
    if (m == null) return null;
    total += m;
  }
  return Math.round(total * 10) / 10;
}
