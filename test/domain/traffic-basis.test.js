import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pickBasisSiteNearAnchor, pickBasisSiteOnRoute } from "../../src/domain/traffic-basis.js";

const cfg = { minCoverage: 0.75 };

function site(id, lat, lng, distanceM) {
  return { id, lat, lng, direction: "northbound", distanceM, name: `site ${id}` };
}

function evaluated(id, lat, lng, distanceM, coverage = 0.9) {
  return {
    site: site(id, lat, lng, distanceM),
    wd: { coverage, daysUsed: 60, dayTotal: 1000, shares: new Array(96).fill(1 / 96), yearsUsed: [2024] },
    we: { daysUsed: 8, shares: new Array(96).fill(1 / 96) },
  };
}

describe("pickBasisSiteOnRoute", () => {
  test("prefers nearer route distance among similarly anchored sites", () => {
    const anchor = { lat: 54.97, lng: -1.62 };
    const pool = [
      evaluated(8790, 54.946, -1.636, 37),
      evaluated(15824, 54.947, -1.64, 2),
    ];
    const nearAnchor = pickBasisSiteNearAnchor(pool, "northbound", anchor, cfg);
    const onRoute = pickBasisSiteOnRoute(pool, "northbound", anchor, cfg);
    assert.equal(nearAnchor.site.id, 8790);
    assert.equal(onRoute.site.id, 15824);
  });

  test("ignores on-route sites much farther from the terminal anchor", () => {
    const anchor = { lat: 54.97, lng: -1.62 };
    const pool = [
      evaluated(8790, 54.946, -1.636, 37),
      evaluated(8821, 55.4, -1.9, 11),
    ];
    assert.equal(pickBasisSiteOnRoute(pool, "northbound", anchor, cfg).site.id, 8790);
  });
});
