import { useEffect, useRef } from "react";
import { GeoJSONSource, LngLatBounds, Map as MlMap, NavigationControl, Popup, setWorkerUrl, type MapLayerMouseEvent, type StyleSpecification } from "maplibre-gl";
import type { Feature, Point, Polygon } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 resolves its worker as "./maplibre-gl-worker.mjs" next to its own module, which does not
// exist once Vite has bundled it: the worker never starts and vector tiles + GeoJSON never render.
// Let Vite bundle the worker (with its shared chunk) and hand MapLibre the resulting URL.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
setWorkerUrl(maplibreWorkerUrl);
import type { Direction, DirectionName, EngineDocument, ReferencePin, Stop } from "../types";
import { decodePolyline } from "@engine/lib/polyline.js";
import { SAME_KERB_M, isDepotPin, matchPins, metres, pinDirection } from "../lib/geo";
import { baselineSampleId, deadLegs, depotStop, passengerStops } from "../lib/derive";
import { isNum } from "../lib/format";
import { num } from "../lib/format";

/** Keyless basemap: OpenFreeMap (vector, OSM data). Falls back to OSM raster tiles if it fails to load. */
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

/** Fonts served by OpenFreeMap's glyph endpoint; MapLibre's default stack ("Open Sans…") 404s there. */
const FONT = ["Noto Sans Regular"], FONT_BOLD = ["Noto Sans Bold"];

/** Index of the polyline vertex nearest a point. */
function nearestVertex(coords: [number, number][], p: { lat: number; lng: number }): number {
  let best = 0, bestM = Infinity;
  coords.forEach(([lng, lat], i) => { const m = metres({ lat, lng }, p); if (m < bestM) { bestM = m; best = i; } });
  return best;
}

/**
 * Route geometry split into the passenger run and the dead leg (depot → first stop outbound, last stop → depot
 * return). The Google polyline starts/ends at the depot and is cut at the vertex nearest the terminus.
 */
function routeFeatures(dir: Direction | undefined, name: DirectionName): { route: Feature | null; dead: Feature | null } {
  if (!dir?.routePolyline) return { route: null, dead: null };
  const coords = decodePolyline(dir.routePolyline);
  const line = (c: [number, number][], dead: boolean): Feature | null =>
    c.length < 2 ? null : { type: "Feature", properties: { direction: name, dead }, geometry: { type: "LineString", coordinates: c } };
  const depot = depotStop(dir);
  if (!depot) return { route: line(coords, false), dead: null };
  const pax = passengerStops(dir);
  if (name === "outbound") {
    const cut = nearestVertex(coords, pax[0].coordinates);
    return { dead: line(coords.slice(0, cut + 1), true), route: line(coords.slice(cut), false) };
  }
  const cut = nearestVertex(coords, pax[pax.length - 1].coordinates);
  return { route: line(coords.slice(0, cut + 1), false), dead: line(coords.slice(cut), true) };
}

function stopFeatures(dir: Direction | undefined, name: DirectionName): Feature[] {
  return passengerStops(dir).map((s) => ({
    type: "Feature",
    properties: {
      direction: name,
      id: s.naptanId,
      seq: s.sequenceOrder,
      name: s.stopName,
      locality: s.localityName ?? "",
      population: s.catchment?.population ?? null,
      deviation: s.deviationMinutes ?? null,
      time: s.proposedTimes?.[0] ?? "",
    },
    geometry: { type: "Point", coordinates: [s.coordinates.lng, s.coordinates.lat] },
  }));
}

function catchmentFeatures(dir: Direction | undefined): Feature[] {
  return (dir?.orderedStops ?? [])
    .filter((s) => s.catchment?.polygon)
    .map((s) => ({ type: "Feature", properties: { id: s.naptanId, population: s.catchment?.population ?? null }, geometry: s.catchment!.polygon as Polygon }));
}

/** Interviewer pins: the current direction's layer is matched to stops; the other layer is drawn faint. */
function pinFeatures(pins: ReferencePin[], dir: Direction | undefined, direction: DirectionName): { pins: Feature[]; snaps: Feature[] } {
  const out: Feature[] = [], snaps: Feature[] = [];
  const matches = matchPins(pins, dir?.orderedStops ?? [], direction);
  for (const m of matches) {
    out.push({
      type: "Feature",
      properties: { layer: m.pin.layer, name: m.pin.name, seq: m.pin.seq, active: true, direction, stopName: m.stop?.stopName ?? null, stopId: m.stop?.naptanId ?? null, metres: Math.round(m.metres), lat: m.pin.lat, lng: m.pin.lng },
      geometry: { type: "Point", coordinates: [m.pin.lng, m.pin.lat] },
    });
    if (m.stop) {
      snaps.push({
        type: "Feature",
        properties: { metres: Math.round(m.metres), big: m.metres > SAME_KERB_M },
        geometry: { type: "LineString", coordinates: [[m.pin.lng, m.pin.lat], [m.stop.coordinates.lng, m.stop.coordinates.lat]] },
      });
    }
  }
  for (const p of pins) {
    if (pinDirection(p) === direction || isDepotPin(p)) continue;
    out.push({ type: "Feature", properties: { layer: p.layer, name: p.name, seq: p.seq, active: false, direction: pinDirection(p) ?? "", stopName: null, stopId: null, metres: null, lat: p.lat, lng: p.lng }, geometry: { type: "Point", coordinates: [p.lng, p.lat] } });
  }
  return { pins: out, snaps };
}

/** Depot marker — dead-leg distance/time from the engine leg flagged deadLeg; allowance from timetableColumns[].deadLegs (§5.1). */
function depotFeatures(doc: EngineDocument, direction: DirectionName): Feature[] {
  const dir = doc.directions[direction];
  const depot = depotStop(dir);
  if (!depot) return [];
  const pax = passengerStops(dir);
  const end = direction === "outbound" ? pax[0] : pax[pax.length - 1];
  const leg = deadLegs(dir)[direction === "outbound" ? 0 : deadLegs(dir).length - 1];
  const baseline = baselineSampleId(doc.estimatedTemporalWindows, direction);
  const key = direction === "outbound" ? "toFirstStop" : "fromLastStop";
  const checks = doc.timetableColumns.map((c) => ({ id: c.columnId, ...c.deadLegs?.[key] })).filter((c) => isNum(c.allowanceMin));
  const props = {
    name: depot.stopName, lat: depot.coordinates.lat, lng: depot.coordinates.lng, direction,
    endStop: end?.stopName ?? null,
    legKm: leg?.distanceKm ?? null,
    legMin: leg?.coachAdjustedMin?.central ?? null,
    legMinPeak: leg?.windows?.peak1?.durationMin ?? null,
    legMinValley: leg?.windows?.[baseline]?.durationMin ?? null,
    deadKm: doc.fleet?.distance?.deadKm ?? null,
    checks: JSON.stringify(checks),
  };
  return [{ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [depot.coordinates.lng, depot.coordinates.lat] } }];
}

function depotPopupHtml(p: Record<string, unknown>): string {
  const rows: string[] = [];
  const legName = p.direction === "outbound" ? "Depot run to first stop" : "Depot run from last stop";
  if (p.endStop && p.legKm != null) {
    rows.push(`<div>${legName}: <b>${p.endStop}</b><br/>${num(Number(p.legKm), 1)} km routed · ${num(Number(p.legMin), 1)} min coach central (car: peak ${num(Number(p.legMinPeak), 1)} / valley ${num(Number(p.legMinValley), 1)} min)</div>`);
  }
  const checks = JSON.parse(String(p.checks ?? "[]")) as Array<{ id: string; allowanceMin: number; routedMin: number; slackMin: number; band: string }>;
  if (checks.length) {
    const bad = checks.filter((c) => c.slackMin < 0);
    const minSlack = Math.min(...checks.map((c) => c.slackMin));
    rows.push(`<div>Timetable allowance: <b>${checks[0].allowanceMin} min</b> in every column · tightest slack <b style="color:${minSlack < 0 ? "#b42318" : minSlack < 3 ? "#b7791f" : "#216564"}">${minSlack >= 0 ? "+" : ""}${num(minSlack, 1)} min</b></div>`);
    if (bad.length) rows.push(`<div style="color:#b42318">Too tight: ${bad.map((c) => `${c.id} (${c.band}, ${num(c.routedMin, 1)} min routed, ${num(c.slackMin, 1)})`).join("; ")}</div>`);
    else rows.push(`<div style="color:#216564">Every column reaches the terminus in time</div>`);
  }
  if (p.deadKm != null) rows.push(`<div>Depot runs: <b>${num(Number(p.deadKm), 1)} km</b> per return trip (both legs, §5.1)</div>`);
  rows.push(`<div><i>Not a passenger stop — no catchment, demand or supply computed</i></div>`);
  return `<div style="font:13px system-ui"><b>${p.name}</b><div style="color:#5f6b7a">Depot · ${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}</div>${rows.join("")}</div>`;
}

function stopPopupHtml(p: Record<string, unknown>): string {
  const rows: string[] = [];
  if (p.time) rows.push(`<div>Proposed time (col 1): <b>${p.time}</b></div>`);
  if (p.population != null) rows.push(`<div>10-min walk catchment: <b>${num(p.population)}</b> residents</div>`);
  if (p.deviation != null) rows.push(`<div>Deviation: <b>${num(p.deviation, 1)} min</b></div>`);
  return `<div style="font:13px system-ui"><b>${p.seq}. ${p.name}</b><div style="color:#5f6b7a">${p.locality} · <code>${p.id}</code> (NaPTAN)</div>${rows.join("")}</div>`;
}

function pinPopupHtml(p: Record<string, unknown>): string {
  const coords = `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}`;
  const match = p.stopName
    ? `<div>Engine uses: <b>${p.stopName}</b> <code>${p.stopId}</code><br/><b>${p.metres} m</b> from this pin${Number(p.metres) > SAME_KERB_M ? " — <span style=\"color:#b7791f\">offset</span>" : ""}</div>`
    : p.active ? `<div style="color:#b42318">No stop within 400 m in this direction</div>` : `<div style="color:#5f6b7a">Other direction's layer — switch direction to see its match</div>`;
  return `<div style="font:13px system-ui"><b>Given pin: ${p.name}</b><div style="color:#5f6b7a">${p.layer} layer · ${coords}</div>${match}</div>`;
}

export interface RouteMapProps {
  doc: EngineDocument;
  direction: DirectionName;
  pins?: ReferencePin[];
  showPins?: boolean;
  selected?: string;
  onSelect?: (s: Stop) => void;
}

export default function RouteMap({ doc, direction, pins = [], showPins = true, selected, onSelect }: RouteMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const pending = useRef<(() => void) | null>(null);
  const latest = useRef({ doc, direction, onSelect });
  latest.current = { doc, direction, onSelect };

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new MlMap({ container: el.current, style: STYLE, center: [-1.9, 55.4], zoom: 7, attributionControl: { compact: true } });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    let fellBack = false;
    m.on("error", (e) => {
      // Only fall back if the style document itself fails (URL contains /styles/). Glyph, sprite or tile
      // errors from the same host must not tear down the style — they are recoverable and non-fatal.
      if (!ready.current && !fellBack && /\/styles\//i.test(String(e?.error?.message ?? e?.error ?? ""))) {
        fellBack = true;
        m.setStyle(FALLBACK_STYLE);
      }
    });
    m.on("load", () => {
      const empty = () => ({ type: "FeatureCollection" as const, features: [] as Feature[] });
      for (const id of ["catchments", "routes", "snaps", "stops", "pins", "depot", "dead-legs"]) m.addSource(id, { type: "geojson", data: empty() });
      const root = getComputedStyle(document.documentElement);
      const css = (name: string) => root.getPropertyValue(name).trim();
      m.addLayer({ id: "dead-legs", type: "line", source: "dead-legs", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#5f6b7a", "line-width": 3 } });
      m.addLayer({ id: "catchments-fill", type: "fill", source: "catchments", paint: { "fill-color": css("--catchment-fill"), "fill-opacity": 1 } });
      m.addLayer({ id: "catchments-line", type: "line", source: "catchments", paint: { "line-color": css("--catchment-line"), "line-width": 1, "line-opacity": 1 } });
      const dirColour: [
        "match",
        ["get", "direction"],
        string,
        string,
        string,
      ] = [
        "match",
        ["get", "direction"],
        "outbound",
        css("--outbound"),
        css("--return"),
      ];
      m.addLayer({ id: "routes-other", type: "line", source: "routes", paint: { "line-color": dirColour, "line-width": 2, "line-opacity": 0.3 } });
      m.addLayer({ id: "routes-active", type: "line", source: "routes", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dirColour, "line-width": 4 } });
      m.addLayer({ id: "snaps", type: "line", source: "snaps", paint: { "line-color": ["case", ["get", "big"], "#b7791f", "#5f6b7a"], "line-width": 2, "line-dasharray": [1, 1.5] } });
      // Given pins: yellow diamonds (rotated squares) so they read differently from stop circles. Drawn
      // beneath the engine stops so the stop the engine actually uses is always visible on top.
      m.addLayer({ id: "pins", type: "symbol", source: "pins", layout: { "icon-image": "pin-diamond", "icon-size": ["case", ["get", "active"], 1, 0.7], "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-opacity": ["case", ["get", "active"], 1, 0.45] } });
      m.addLayer({ id: "stops", type: "circle", source: "stops", paint: { "circle-radius": 6, "circle-color": dirColour, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
      m.addLayer({ id: "stop-labels", type: "symbol", source: "stops", layout: { "text-field": ["concat", ["to-string", ["get", "seq"]], " ", ["get", "name"]], "text-font": FONT, "text-size": 11, "text-offset": [0.9, 0], "text-anchor": "left", "text-optional": true }, paint: { "text-color": "#0c0b0a", "text-halo-color": "#ffffff", "text-halo-width": 1.2 } });
      m.addLayer({ id: "pin-labels", type: "symbol", source: "pins", filter: ["==", ["get", "active"], true], layout: { "text-field": ["concat", ["get", "metres"], " m"], "text-font": FONT, "text-size": 10, "text-offset": [0, -1.4], "text-anchor": "bottom", "text-optional": true }, paint: { "text-color": css("--kmz-pin"), "text-halo-color": "#ffffff", "text-halo-width": 1.2 } });
      // Depot: dark square with a "D", always labelled — it is not a stop so must not look like one.
      m.addLayer({ id: "depot", type: "symbol", source: "depot", layout: { "icon-image": "depot-square", "icon-allow-overlap": true, "icon-ignore-placement": true, "text-field": ["get", "name"], "text-font": FONT_BOLD, "text-size": 11, "text-offset": [1.1, 0], "text-anchor": "left", "text-allow-overlap": true }, paint: { "text-color": "#0c0b0a", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });

      // Icons drawn on a canvas (no sprite dependency).
      const size = 22, c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d")!;
      g.beginPath(); g.moveTo(size / 2, 1); g.lineTo(size - 1, size / 2); g.lineTo(size / 2, size - 1); g.lineTo(1, size / 2); g.closePath();
      g.fillStyle = css("--kmz-pin"); g.fill(); g.lineWidth = 2; g.strokeStyle = css("--ink"); g.stroke();
      m.addImage("pin-diamond", g.getImageData(0, 0, size, size), { pixelRatio: 1 });
      g.clearRect(0, 0, size, size);
      g.fillStyle = "#0c0b0a"; g.fillRect(2, 2, size - 4, size - 4);
      g.lineWidth = 2; g.strokeStyle = "#ffffff"; g.strokeRect(2, 2, size - 4, size - 4);
      g.fillStyle = "#ffffff"; g.font = "bold 13px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("D", size / 2, size / 2 + 1);
      m.addImage("depot-square", g.getImageData(0, 0, size, size), { pixelRatio: 1 });

      const openPopup = (e: MapLayerMouseEvent, html: (p: Record<string, unknown>) => string) => {
        const f = e.features?.[0];
        if (!f) return null;
        const p = f.properties as Record<string, unknown>;
        new Popup({ closeButton: false, maxWidth: "340px" }).setLngLat((f.geometry as Point).coordinates as [number, number]).setHTML(html(p)).addTo(m);
        return p;
      };
      m.on("click", "stops", (e) => {
        const p = openPopup(e, stopPopupHtml);
        const { doc: d, direction: dir, onSelect: sel } = latest.current;
        const stop = p && d.directions[dir]?.orderedStops.find((s) => s.naptanId === p.id);
        if (stop && sel) sel(stop);
      });
      m.on("click", "pins", (e) => { openPopup(e, pinPopupHtml); });
      m.on("click", "depot", (e) => { openPopup(e, depotPopupHtml); });
      for (const id of ["stops", "pins", "depot"]) {
        m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
      }
      ready.current = true;
      pending.current?.();
      pending.current = null;
    });
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __map?: MlMap }).__map = m;
    return () => { m.remove(); map.current = null; ready.current = false; };
  }, []);

  // Data + styling that depends on props.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      const dir = doc.directions[direction];
      const fc = (features: Feature[]) => ({ type: "FeatureCollection" as const, features });
      const rf = (["outbound", "return"] as DirectionName[]).map((d) => routeFeatures(doc.directions[d], d));
      (m.getSource("routes") as GeoJSONSource).setData(fc(rf.map((r) => r.route).filter((f): f is Feature => !!f)));
      // Dead leg of the active direction only (the other direction's is visual noise at route scale).
      (m.getSource("dead-legs") as GeoJSONSource).setData(fc(rf.map((r) => r.dead).filter((f): f is Feature => !!f && f.properties?.direction === direction)));
      (m.getSource("stops") as GeoJSONSource).setData(fc(stopFeatures(dir, direction)));
      (m.getSource("catchments") as GeoJSONSource).setData(fc(catchmentFeatures(dir)));
      const pf = pinFeatures(pins, dir, direction);
      (m.getSource("pins") as GeoJSONSource).setData(fc(showPins ? pf.pins : []));
      (m.getSource("snaps") as GeoJSONSource).setData(fc(showPins ? pf.snaps : []));
      (m.getSource("depot") as GeoJSONSource).setData(fc(depotFeatures(doc, direction)));
      m.setFilter("routes-other", ["!=", ["get", "direction"], direction]);
      m.setFilter("routes-active", ["==", ["get", "direction"], direction]);
      m.setPaintProperty("stops", "circle-radius", ["case", ["==", ["get", "id"], selected ?? ""], 9, 6]);
    };
    if (ready.current) apply();
    else pending.current = apply;
  }, [doc, direction, pins, showPins, selected]);

  // Fit to the route when the scenario or direction changes.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const fit = () => {
      const stops = doc.directions[direction]?.orderedStops ?? [];
      if (!stops.length) return;
      const b = new LngLatBounds();
      for (const s of stops) b.extend([s.coordinates.lng, s.coordinates.lat]);
      m.fitBounds(b, { padding: 50, duration: 600 });
    };
    if (ready.current) fit();
    else { const prev = pending.current; pending.current = () => { prev?.(); fit(); }; }
  }, [doc.routeId, direction, pins.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom to a stop chosen from the table — close enough to see kerbs and pins.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current || !selected) return;
    const s = doc.directions[direction]?.orderedStops.find((x) => x.naptanId === selected);
    if (s) m.easeTo({ center: [s.coordinates.lng, s.coordinates.lat], zoom: Math.max(m.getZoom(), 17), duration: 600 });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="map" />;
}
