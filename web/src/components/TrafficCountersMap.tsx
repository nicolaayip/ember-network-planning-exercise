import { useEffect, useMemo, useRef } from "react";
import {
  GeoJSONSource,
  LngLatBounds,
  Map as MlMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import type { Feature, Point } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { DirectionName, EngineDocument, TrafficBasisSite } from "../types";
import { decodePolyline } from "@engine/lib/polyline.js";
import { compassIconRotate, formatLatLng, nearestPointOnPolyline } from "../lib/geo";
import { passengerStops } from "../lib/derive";

setWorkerUrl(maplibreWorkerUrl);

const STYLE = "https://tiles.openfreemap.org/styles/bright";
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

/** Neutral map styling — weekday/weekend colours are reserved for the charts. */
const COUNTER = "#3d3d3a";
const ANCHOR = "#6b645d";
const ROUTE = "#9a958c";

const SOURCE_IDS = ["routes", "anchors", "counters", "counter-links", "route-projection"] as const;
const ROUTE_OFFSET_NOTE_M = 15;

function locatedSites(
  sites: TrafficBasisSite[],
  direction: DirectionName,
): Array<TrafficBasisSite & { lat: number; lng: number }> {
  return sites.filter(
    (s): s is TrafficBasisSite & { lat: number; lng: number } =>
      s.serviceDirection === direction && Number.isFinite(s.lat) && Number.isFinite(s.lng),
  );
}

function terminalAnchorFeatures(doc: EngineDocument): Feature[] {
  const features: Feature[] = [];
  for (const dir of ["outbound", "return"] as DirectionName[]) {
    const anchor = passengerStops(doc.directions[dir])[0];
    if (!anchor) continue;
    features.push({
      type: "Feature",
      properties: { name: anchor.stopName, direction: dir },
      geometry: {
        type: "Point",
        coordinates: [anchor.coordinates.lng, anchor.coordinates.lat],
      },
    });
  }
  return features;
}

/** Corridor extent for map framing — stable when switching outbound/return. */
function corridorCoords(doc: EngineDocument): [number, number][] {
  const coords: [number, number][] = [];
  for (const dir of ["outbound", "return"] as DirectionName[]) {
    const poly = doc.directions[dir]?.routePolyline;
    if (poly) coords.push(...decodePolyline(poly));
    else {
      for (const s of doc.directions[dir]?.orderedStops ?? []) {
        coords.push([s.coordinates.lng, s.coordinates.lat]);
      }
    }
  }
  return coords;
}

function frameCorridor(map: MlMap, doc: EngineDocument) {
  const coords = corridorCoords(doc);
  map.resize();
  if (coords.length >= 2) {
    const b = new LngLatBounds();
    for (const c of coords) b.extend(c);
    map.fitBounds(b, { padding: 48, duration: 0 });
  } else if (coords.length === 1) {
    map.easeTo({ center: coords[0], zoom: 9, duration: 0 });
  }
}

function frameCounter(map: MlMap, site: { lat: number; lng: number }) {
  map.resize();
  const b = new LngLatBounds();
  b.extend([site.lng, site.lat]);
  b.extend([site.lng + 0.012, site.lat + 0.008]);
  b.extend([site.lng - 0.012, site.lat - 0.008]);
  map.fitBounds(b, { padding: 24, maxZoom: 13, duration: 0 });
}

function counterPopup(site: TrafficBasisSite, routeOffsetM?: number): string {
  const coords =
    site.lat != null && site.lng != null ? formatLatLng({ lat: site.lat, lng: site.lng }) : "";
  return `<div style="font:13px system-ui;max-width:280px">
    <b>Vehicle counter</b>
    <div style="color:#5f6b7a;margin-top:4px"><code>${site.id}</code>${site.compass ? ` · ${site.compass}` : ""}</div>
    ${site.name ? `<div style="margin-top:6px">${site.name}</div>` : ""}
    ${site.anchorStopName ? `<div style="margin-top:4px;color:#5f6b7a">Near ${site.anchorStopName}</div>` : ""}
    ${routeOffsetM != null && routeOffsetM > ROUTE_OFFSET_NOTE_M ? `<div style="margin-top:4px;color:#5f6b7a">${Math.round(routeOffsetM)} m from driven route — counter is on a nearby A-road link</div>` : ""}
    ${coords ? `<div style="margin-top:4px"><code>${coords}</code></div>` : ""}
  </div>`;
}

/** Arrow tip points north; rotate with icon-rotate + icon-anchor bottom to show traffic bearing. */
function addArrowImage(map: MlMap) {
  if (map.hasImage("counter-arrow")) return;
  const w = 24;
  const h = 32;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, w, h);
  g.translate(w / 2, h - 1);
  g.beginPath();
  g.moveTo(0, -26);
  g.lineTo(8, -4);
  g.lineTo(3, -4);
  g.lineTo(3, 0);
  g.lineTo(-3, 0);
  g.lineTo(-3, -4);
  g.lineTo(-8, -4);
  g.closePath();
  g.fillStyle = COUNTER;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = "#0c0b0a";
  g.stroke();
  map.addImage("counter-arrow", g.getImageData(0, 0, w, h), { pixelRatio: 1 });
}

function ensureLayers(map: MlMap) {
  const empty = () => ({ type: "FeatureCollection" as const, features: [] as Feature[] });
  for (const id of SOURCE_IDS) {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: empty() });
  }
  if (!map.getLayer("routes")) {
    map.addLayer({
      id: "routes",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ROUTE, "line-width": 2.5, "line-opacity": 0.45 },
    });
  }
  if (!map.getLayer("anchors")) {
    map.addLayer({
      id: "anchors",
      type: "circle",
      source: "anchors",
      paint: {
        "circle-radius": 5,
        "circle-color": ANCHOR,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
  }
  if (!map.getLayer("counters")) {
    map.addLayer({
      id: "counters",
      type: "circle",
      source: "counters",
      paint: {
        "circle-radius": 7,
        "circle-color": COUNTER,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
  }
  addArrowImage(map);
  if (!map.getLayer("counter-arrows")) {
    map.addLayer({
      id: "counter-arrows",
      type: "symbol",
      source: "counters",
      layout: {
        "icon-image": "counter-arrow",
        "icon-size": 1,
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map",
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }
  if (!map.getLayer("counter-links")) {
    map.addLayer({
      id: "counter-links",
      type: "line",
      source: "counter-links",
      layout: { "line-cap": "round" },
      paint: {
        "line-color": COUNTER,
        "line-width": 1.5,
        "line-opacity": 0.55,
        "line-dasharray": [2, 2],
      },
    });
  }
  if (!map.getLayer("route-projection")) {
    map.addLayer({
      id: "route-projection",
      type: "circle",
      source: "route-projection",
      paint: {
        "circle-radius": 4,
        "circle-color": ROUTE,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });
  }
}

export default function TrafficCountersMap({
  doc,
  sites,
  direction,
  embed = false,
  showLegend = true,
  frameMode = embed ? "counter" : "corridor",
  className = "",
}: {
  doc: EngineDocument;
  sites: TrafficBasisSite[];
  direction: DirectionName;
  /** Compact preview — frames the counter, not the full corridor. */
  embed?: boolean;
  showLegend?: boolean;
  frameMode?: "corridor" | "counter";
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const pending = useRef<(() => void) | null>(null);
  const framedRouteRef = useRef<string | null>(null);
  const docRef = useRef(doc);
  const markersRef = useRef(locatedSites(sites, direction));
  docRef.current = doc;

  const markers = useMemo(() => locatedSites(sites, direction), [sites, direction]);
  markersRef.current = markers;

  const geo = useMemo(() => {
    const routeCoords = doc.directions[direction]?.routePolyline
      ? decodePolyline(doc.directions[direction].routePolyline!)
      : [];
    const routeOffsets = new Map<string, number>();

    const counters: Feature[] = markers.map((s) => {
      const nearest = routeCoords.length >= 2 ? nearestPointOnPolyline({ lat: s.lat, lng: s.lng }, routeCoords) : null;
      const offsetM = s.routeDistanceM ?? nearest?.metres ?? 0;
      routeOffsets.set(String(s.id), offsetM);
      return {
        type: "Feature",
        properties: {
          id: s.id,
          bearing: compassIconRotate(s.compass),
          routeOffsetM: offsetM,
        },
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      };
    });

    const counterLinks: Feature[] = [];
    const routeProjection: Feature[] = [];
    for (const s of markers) {
      const offsetM = routeOffsets.get(String(s.id)) ?? 0;
      if (offsetM <= ROUTE_OFFSET_NOTE_M || routeCoords.length < 2) continue;
      const nearest = nearestPointOnPolyline({ lat: s.lat, lng: s.lng }, routeCoords);
      if (!nearest) continue;
      counterLinks.push({
        type: "Feature",
        properties: { id: s.id },
        geometry: {
          type: "LineString",
          coordinates: [[s.lng, s.lat], nearest.point],
        },
      });
      routeProjection.push({
        type: "Feature",
        properties: { id: s.id },
        geometry: { type: "Point", coordinates: nearest.point },
      });
    }

    const anchors = terminalAnchorFeatures(doc);

    const routes: Feature[] = [];
    if (routeCoords.length >= 2) {
      routes.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: routeCoords },
      });
    }

    return { counters, anchors, routes, counterLinks, routeProjection, routeOffsets };
  }, [doc, direction, markers]);

  useEffect(() => {
    if (!el.current || mapRef.current) return;
    const map = new MlMap({
      container: el.current,
      style: STYLE,
      center: [-2, 55.4],
      zoom: 7,
      attributionControl: embed ? false : { compact: true },
      interactive: !embed,
    });
    if (!embed) map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    let fellBack = false;

    const onLoad = () => {
      ensureLayers(map);
      ready.current = true;
      pending.current?.();
      pending.current = null;
      const d = docRef.current;
      const site = markersRef.current[0];
      if (frameMode === "counter" && site) {
        frameCounter(map, site);
      } else if (framedRouteRef.current !== d.routeId) {
        framedRouteRef.current = d.routeId;
        frameCorridor(map, d);
      }
      map.resize();
    };

    map.on("error", (e) => {
      if (!ready.current && !fellBack && /\/styles\//i.test(String(e?.error?.message ?? e?.error ?? ""))) {
        fellBack = true;
        map.setStyle(FALLBACK_STYLE);
      }
    });
    map.on("load", onLoad);

    const openPopup = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const site = markersRef.current.find((s) => String(s.id) === String(f.properties?.id));
      if (!site) return;
      const [lng, lat] = (f.geometry as Point).coordinates;
      const routeOffsetM = Number(f.properties?.routeOffsetM);
      new Popup({ closeButton: false, maxWidth: "320px" })
        .setLngLat([lng, lat])
        .setHTML(counterPopup(site, Number.isFinite(routeOffsetM) ? routeOffsetM : undefined))
        .addTo(map);
    };
    map.on("click", "counters", openPopup);
    map.on("mouseenter", "counters", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "counters", () => {
      map.getCanvas().style.cursor = "";
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      ready.current = false;
      pending.current = null;
      framedRouteRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      const fc = (features: Feature[]) => ({ type: "FeatureCollection" as const, features });
      (map.getSource("routes") as GeoJSONSource).setData(fc(geo.routes));
      (map.getSource("anchors") as GeoJSONSource).setData(fc(geo.anchors));
      (map.getSource("counters") as GeoJSONSource).setData(fc(geo.counters));
      (map.getSource("counter-links") as GeoJSONSource).setData(fc(geo.counterLinks));
      (map.getSource("route-projection") as GeoJSONSource).setData(fc(geo.routeProjection));
      map.resize();
    };

    if (ready.current) apply();
    else pending.current = apply;
  }, [geo, markers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const site = markers[0];
    if (frameMode === "counter" && site) {
      frameCounter(map, site);
      return;
    }
    if (framedRouteRef.current === doc.routeId) return;
    framedRouteRef.current = doc.routeId;
    frameCorridor(map, doc);
  }, [doc.routeId, frameMode, markers]);

  useEffect(() => {
    const node = el.current;
    const map = mapRef.current;
    if (!node || !map) return;
    const ro = new ResizeObserver(() => {
      if (ready.current) map.resize();
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  if (!markers.length) {
    return (
      <p className="small muted">
        Counter coordinates not in this scenario — re-run the engine and sync scenarios.
      </p>
    );
  }

  const basis = markers[0];
  const routeOffsetM = geo.routeOffsets.get(String(basis.id)) ?? 0;

  const mapClass = ["map", "traffic-counters-map", embed && "traffic-counters-map--embed", className]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div className={mapClass} ref={el} />
      {showLegend && (
        <div className="legend" style={{ marginTop: 8 }}>
          <span>
            <i className="swatch" style={{ background: COUNTER }} />
            Vehicle counter
          </span>
          <span>
            <i className="swatch" style={{ background: ANCHOR }} />
            Terminal stops
          </span>
          <span className="small muted">
            Arrow = {basis.compass ?? "traffic"} flow · grey line = {direction} route
            {routeOffsetM > ROUTE_OFFSET_NOTE_M ? ` · dashed link = ${Math.round(routeOffsetM)} m to route` : ""}
          </span>
        </div>
      )}
    </>
  );
}
