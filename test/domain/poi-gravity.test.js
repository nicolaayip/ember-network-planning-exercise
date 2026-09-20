/** @format */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as turf from "@turf/turf";
import { poiGravity, distanceDecay, POI_WEIGHTS } from "../../src/domain/poi-gravity.js";
import { classify } from "../../src/adapters/overpass.js";

// Stop at 55°N, 0°E; a ~1.2 km square isochrone around it (0.0108° lat ≈ 1.2 km).
const stop = { lat: 55, lng: 0 };
const iso = turf.polygon([
  [
    [-0.0095, 54.9946],
    [0.0095, 54.9946],
    [0.0095, 55.0054],
    [-0.0095, 55.0054],
    [-0.0095, 54.9946],
  ],
]);
// 1° lat ≈ 111.32 km → 0.0027° ≈ 300 m; 0.0054° ≈ 600 m; 0.009° ≈ 1000 m
const at = (metresNorth, group, id) => ({
  id,
  group,
  name: id,
  lat: 55 + metresNorth / 111_320,
  lng: 0,
});

describe("distanceDecay", () => {
  test("1.0 to 400 m, 0.5 to 800 m, 0 beyond", () => {
    assert.equal(distanceDecay(0), 1);
    assert.equal(distanceDecay(400), 1);
    assert.equal(distanceDecay(401), 0.5);
    assert.equal(distanceDecay(800), 0.5);
    assert.equal(distanceDecay(801), 0);
  });
});

describe("classify", () => {
  test("maps OSM tags to the four §3.5 groups, first match wins, unknown → null", () => {
    assert.equal(classify({ amenity: "hospital" }), "medical");
    assert.equal(classify({ shop: "supermarket" }), "retail");
    assert.equal(classify({ amenity: "university" }), "education");
    assert.equal(classify({ leisure: "park" }), "leisure");
    assert.equal(classify({ amenity: "bus_station" }), "leisure");
    assert.equal(classify({ shop: "bakery" }), null);
    assert.equal(classify(undefined), null);
  });
});

describe("poiGravity", () => {
  test("weights by group and day type with distance decay", () => {
    const features = [
      at(300, "medical", "hosp"), // x1.0 → 10 / 2
      at(600, "retail", "shop"), // x0.5 → 3.5 / 4
      at(-300, "leisure", "park"), // x1.0 → 2 / 10
    ];
    const g = poiGravity(stop, iso, features);
    assert.equal(g.weekday, 15.5);
    assert.equal(g.weekend, 16);
    assert.deepEqual(g.counts, { medical: 1, retail: 1, education: 0, leisure: 1 });
    assert.equal(g.features[0].id, "hosp", "sorted by combined contribution");
  });

  test("features outside the isochrone or beyond 800 m contribute nothing", () => {
    const features = [
      at(1000, "medical", "far-in-bbox-but-outside-decay"), // inside polygon? 1000 m N is outside the 600 m half-height → outside polygon anyway
      at(500, "education", "uni-in"), // x0.5 → 3.5 / 0.5
    ];
    const g = poiGravity(stop, iso, features);
    assert.equal(g.weekday, 3.5);
    assert.equal(g.weekend, 0.5);
    assert.equal(g.counts.medical, 0);
  });

  test("duplicate OSM ids are counted once; unknown groups ignored", () => {
    const f = at(100, "retail", "dup");
    const g = poiGravity(stop, iso, [f, { ...f }, at(100, "mystery", "x")]);
    assert.equal(g.counts.retail, 1);
    assert.equal(g.weekday, POI_WEIGHTS.retail.weekday);
  });

  test("empty input → zero scores", () => {
    const g = poiGravity(stop, iso, []);
    assert.deepEqual([g.weekday, g.weekend, g.features.length], [0, 0, 0]);
  });
});
