import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { parseStringPromise } from "xml2js";
import { loadNaptan } from "../../src/adapters/naptan.js";
import { haversineMetres } from "../../src/lib/geo.js";

/** Same as web/src/lib/geo.ts KMZ_ALIGN_M — pin alignment flagged above this in the dashboard. */
const reviewAboveM = 5;

/**
 * @param {string} kmzPath
 * @param {{ routeId?: string, name?: string, depotName?: string, radius?: string|number, out?: string }} [opts]
 * @returns {Promise<string>} output fixture path
 */
export async function importKmz(kmzPath, opts = {}) {
  const routeId = opts.routeId ?? "newcastle-edinburgh";
  const name = opts.name ?? "Newcastle – Edinburgh (A1)";
  const depotName = opts.depotName ?? "Depot";
  const radiusM = Number(opts.radius ?? 10);
  const outPath = opts.out ?? path.join("fixtures", "routes", `${routeId}.json`);

  const zip = new AdmZip(kmzPath);
  const kmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(".kml"));
  if (!kmlEntry) throw new Error("No .kml inside the KMZ");
  const kml = await parseStringPromise(kmlEntry.getData().toString("utf8"), { explicitArray: false, trim: true });

  const doc = kml.kml.Document;
  const folders = [].concat(doc.Folder ?? []);
  if (folders.length === 0) throw new Error("KML has no Folders; expected Outbound and Return layers");

  const text = (v) => (typeof v === "string" ? v : v?._ ?? "").trim();
  const layers = folders.map((f) => ({
    name: text(f.name),
    placemarks: [].concat(f.Placemark ?? []).map((p) => {
      const [lng, lat] = text(p.Point?.coordinates).split(",").map(Number);
      return { name: text(p.name), lat, lng };
    }),
  }));

  const pick = (re) => layers.find((l) => re.test(l.name));
  const outboundLayer = pick(/out|north|to edin/i) ?? layers[0];
  const returnLayer = pick(/return|inbound|south|to newc/i) ?? layers[1];
  if (!outboundLayer || !returnLayer || outboundLayer === returnLayer) {
    throw new Error(`Could not identify two direction layers; found: ${layers.map((l) => l.name).join(", ")}`);
  }
  console.error(`Layers: outbound="${outboundLayer.name}" (${outboundLayer.placemarks.length}), return="${returnLayer.name}" (${returnLayer.placemarks.length})`);

  const naptan = await loadNaptan({ log: { info: (o, m) => console.error(m, JSON.stringify(o)) } });
  const isDepot = (n) => new RegExp(depotName, "i").test(n);
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  function matchLayer(layer) {
    const stops = [];
    const depots = [];
    const report = [];
    for (const pm of layer.placemarks) {
      if (isDepot(pm.name)) {
        const d = { name: pm.name, coordinates: { lat: pm.lat, lng: pm.lng } };
        depots.push(d);
        report.push({ placemark: pm.name, status: "depot (not a passenger stop)" });
        stops.push({
          naptanId: `DEPOT:${slug(pm.name)}`,
          role: "depot",
          stopName: pm.name,
          coordinates: d.coordinates,
          dwellTimeBufferSeconds: 0,
          _placemark: pm.name,
          _placemarkCoordinates: d.coordinates,
          _matchStatus: "depot",
        });
        continue;
      }
      const near = naptan.near(pm.lat, pm.lng, radiusM);
      const m = near.length ? { ...near[0], candidates: near.length } : null;
      if (!m) {
        report.push({ placemark: pm.name, status: "NO MATCH", within: `${radiusM} m` });
        stops.push({
          naptanId: `UNMATCHED:${pm.name.replace(/\s+/g, "_")}`,
          stopName: pm.name,
          coordinates: { lat: pm.lat, lng: pm.lng },
          isSingleCarriageway: false,
          _placemark: pm.name,
          _matchStatus: "unmatched",
        });
        continue;
      }
      const needsReview = m.distanceM > reviewAboveM;
      report.push({
        placemark: pm.name,
        status: needsReview ? "nearest (review)" : "nearest stop",
        atco: m.atco,
        naptanName: `${m.name}${m.indicator ? " (" + m.indicator + ")" : ""}`,
        locality: m.locality,
        distanceM: m.distanceM,
        candidates: m.candidates,
      });
      stops.push({
        naptanId: m.atco,
        stopName: m.indicator ? `${m.name} (${m.indicator})` : m.name,
        localityName: m.locality,
        coordinates: { lat: m.lat, lng: m.lng },
        isSingleCarriageway: false,
        _placemark: pm.name,
        _placemarkCoordinates: { lat: pm.lat, lng: pm.lng },
        _matchDistanceM: m.distanceM,
        _matchStatus: needsReview ? "review" : "nearest",
      });
    }
    const pax = stops.filter((s) => s.role !== "depot");
    if (pax.length) {
      pax[0].alwaysServed = true;
      pax[pax.length - 1].alwaysServed = true;
    }
    return { stops, depots, report };
  }

  const outbound = matchLayer(outboundLayer);
  const ret = matchLayer(returnLayer);
  const depot = outbound.depots[0] ?? ret.depots[0] ?? null;
  const paxLabel = (stops) => {
    const p = stops.filter((s) => s.role !== "depot");
    return [p[0]?._placemark, p.at(-1)?._placemark];
  };

  for (const [dirName, s] of [
    ["outbound", outbound.stops],
    ["return", ret.stops],
  ]) {
    const idx = s.findIndex((x) => x.role === "depot");
    const want = dirName === "return" ? s.length - 1 : 0;
    if (idx !== -1 && idx !== want) {
      throw new Error(`${dirName} layer: depot placemark is at position ${idx}, expected ${want} (${dirName === "return" ? "last" : "first"})`);
    }
  }

  const fixture = {
    routeId,
    routeName: name,
    _source: {
      kmz: path.relative(process.cwd(), kmzPath),
      importedAt: new Date().toISOString(),
      matchRadiusM: radiusM,
      matchReviewAboveM: reviewAboveM,
      note: "Draft route fixture. Fields prefixed _ are provenance and are ignored by the engine. Review isSingleCarriageway per stop and any _matchStatus of review. The depot is stops[0] of outbound / last of return with role=depot.",
    },
    depot: depot ? { ...depot, depotToChargerKm: 0 } : undefined,
    directions: {
      outbound: { label: `${paxLabel(outbound.stops)[0]} → ${paxLabel(outbound.stops)[1]}`, stops: outbound.stops },
      return: { label: `${paxLabel(ret.stops)[0]} → ${paxLabel(ret.stops)[1]}`, stops: ret.stops },
    },
    timetableColumns: [],
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");

  const rawOut = path.join(path.dirname(kmzPath), `${routeId}.placemarks.json`);
  writeFileSync(rawOut, JSON.stringify({ source: path.basename(kmzPath), layers }, null, 2) + "\n");

  const fmt = (r) =>
    r.status === "NO MATCH"
      ? `  ${r.placemark.padEnd(26)} NO MATCH within ${r.within}`
      : r.status.startsWith("depot")
        ? `  ${r.placemark.padEnd(26)} ${r.status}`
        : `  ${r.placemark.padEnd(26)} ${r.atco.padEnd(14)} ${r.naptanName.padEnd(44)} ${String(r.distanceM).padStart(4)} m  ${r.status}${r.candidates > 1 ? ` [${r.candidates} cand.]` : ""}`;
  const nPax = (s) => s.filter((x) => x.role !== "depot").length;
  console.error(`\nOUTBOUND (${nPax(outbound.stops)} passenger stops + ${outbound.depots.length} depot)`);
  outbound.report.forEach((r) => console.error(fmt(r)));
  console.error(`\nRETURN (${nPax(ret.stops)} passenger stops + ${ret.depots.length} depot)`);
  ret.report.forEach((r) => console.error(fmt(r)));
  if (depot) console.error(`\nDepot: ${depot.name} @ ${depot.coordinates.lat}, ${depot.coordinates.lng}`);
  const dOut = outbound.depots[0];
  const dRet = ret.depots[0];
  if (dOut && dRet) console.error(`Depot placemarks agree across layers: ${haversineMetres(dOut.coordinates, dRet.coordinates) < 5}`);
  console.error(`\nwrote ${outPath}\nwrote ${rawOut}`);

  return outPath;
}
