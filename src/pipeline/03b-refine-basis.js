/**
 * Pipeline step 3b — REFINE BASIS.
 *
 * 1. List active WebTRIS counters on the driven route polyline (matching compass, within siteRadiusM).
 * 2. Keep the current basis site when already on-route (≤ 20 m); else re-pick the best on-route site near the terminal anchor.
 * 3. On change, re-apply that direction's temporal windows and basis metadata; refresh weekend ratio.
 *
 * No-op when temporal source is not webtris, evaluation cache is missing, or route geometry is absent.
 *
 * @format
 */

import { listSites, sitesNear } from "../adapters/webtris.js";
import { isPassenger } from "../domain/document.js";
import {
  applyDirectionBasis,
  basisSiteRecord,
  evaluateSite,
  patchBasisRouteDistance,
  pickBasisSiteOnRoute,
  refreshWeekendRatio,
} from "../domain/traffic-basis.js";
import { haversineMetres } from "../lib/geo.js";
import { decodePolyline } from "../lib/polyline.js";

export const name = "refine-basis";

const ON_ROUTE_M = 20;
const ANCHOR_SLACK_M = 2000;
const MAX_CANDIDATES = 15;

export async function run(ctx) {
  const { document: doc, config, log } = ctx;
  const cfg = config.traffic;

  if (doc.estimatedTemporalWindows?.source !== "webtris") return ctx;
  if (!ctx.trafficEvaluated?.length || !ctx.trafficWindows?.length) {
    log.warn("refine-basis skipped — no temporal evaluation cache");
    return ctx;
  }
  if (!ctx.routeGeometry?.outbound?.polyline || !ctx.routeGeometry?.return?.polyline) {
    log.warn("refine-basis skipped — no route geometry from topology");
    return ctx;
  }

  const pax = doc.directions.outbound.orderedStops.filter(isPassenger);
  const anchors = { outbound: pax[0].coordinates, return: pax.at(-1).coordinates };
  const anchorNames = { outbound: pax[0].stopName, return: pax.at(-1).stopName };
  const compasses = {
    outbound:
      doc.trafficProfile.outboundCompassDirection ??
      doc.estimatedTemporalWindows.outbound.compass,
    return: doc.estimatedTemporalWindows.return.compass,
  };

  const allSites = await listSites(log);
  const evaluatedById = new Map(ctx.trafficEvaluated.map((e) => [e.site.id, e]));
  const roadRegex = new RegExp(cfg.roadRegex, "i");
  let changed = false;

  for (const dirName of ["outbound", "return"]) {
    const compass = compasses[dirName];
    const points = decodePolyline(ctx.routeGeometry[dirName].polyline).map(
      ([lng, lat]) => ({ lat, lng }),
    );
    const routeNear = sitesNear(allSites, points, cfg.siteRadiusM, roadRegex)
      .filter((s) => /active/i.test(s.status) && s.direction === compass)
      .sort((a, b) => a.distanceM - b.distanceM);

    const currentId = doc.estimatedTemporalWindows[dirName].basisSiteId;
    const currentOnRoute = routeNear.find((s) => s.id === currentId);
    if (currentOnRoute?.distanceM <= ON_ROUTE_M) {
      patchBasisRouteDistance(doc, dirName, currentOnRoute.distanceM);
      log.info(
        {
          direction: dirName,
          siteId: currentId,
          routeDistanceM: currentOnRoute.distanceM,
        },
        "basis site already on route",
      );
      continue;
    }

    const anchorRadiusM = Math.min(
      cfg.siteRadiusM,
      (currentOnRoute
        ? haversineMetres(anchors[dirName], currentOnRoute)
        : cfg.siteRadiusM) + ANCHOR_SLACK_M,
    );
    let candidates = routeNear
      .filter((s) => haversineMetres(anchors[dirName], s) <= anchorRadiusM)
      .slice(0, MAX_CANDIDATES);
    if (currentOnRoute && !candidates.some((s) => s.id === currentId)) {
      candidates.push(currentOnRoute);
    }

    const pool = [];
    for (const site of candidates) {
      let evaluated = evaluatedById.get(site.id);
      if (!evaluated) {
        evaluated = await evaluateSite(
          site,
          ctx.trafficWindows,
          ctx.trafficExcluded,
          log,
        );
        evaluatedById.set(site.id, evaluated);
        ctx.trafficEvaluated.push(evaluated);
      } else {
        evaluated = {
          ...evaluated,
          site: {
            ...evaluated.site,
            distanceM: site.distanceM,
            nearestPointIndex: site.nearestPointIndex,
          },
        };
      }
      pool.push(evaluated);
    }

    const pick = pickBasisSiteOnRoute(
      pool,
      compass,
      anchors[dirName],
      cfg,
      ANCHOR_SLACK_M,
    );
    if (!pick) {
      log.warn({ direction: dirName }, "refine-basis: no qualifying on-route counter");
      continue;
    }
    if (pick.site.id === currentId) {
      if (pick.site.distanceM != null)
        patchBasisRouteDistance(doc, dirName, pick.site.distanceM);
      continue;
    }

    applyDirectionBasis(
      doc,
      dirName,
      pick,
      basisSiteRecord(dirName, compass, anchorNames[dirName], pick),
    );
    changed = true;
    log.info(
      {
        direction: dirName,
        from: currentId,
        to: pick.site.id,
        routeDistanceM: pick.site.distanceM,
        anchorDistanceM: Math.round(haversineMetres(anchors[dirName], pick.site)),
      },
      "refined basis site onto driven route",
    );
  }

  if (changed) {
    refreshWeekendRatio(doc);
    doc.trafficProfile.source =
      "National Highways WebTRIS (England SRN); route-aligned basis sites per direction";
  }

  return ctx;
}
