import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const fracToMinutes = (f) => Math.round(Number(f) * 24 * 60);
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const norm = (s) => String(s ?? "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const isDepotRow = (label) => /not for passengers|depot/i.test(label);

/**
 * @param {string} xlsxPath
 * @param {string} fixturePath
 * @param {{ sheet?: string }} [opts]
 */
export async function importTimetable(xlsxPath, fixturePath, opts = {}) {
  const wb = XLSX.readFile(xlsxPath, { cellDates: false });
  const sheetName = opts.sheet ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });

  const blocks = {};
  let current = null;
  let daysLabel = null;
  for (const r of rows) {
    const label = r[0];
    if (typeof label === "string" && /timetable/i.test(label) && /outbound|return/i.test(label)) {
      current = /outbound/i.test(label) ? "outbound" : "return";
      blocks[current] = [];
      daysLabel = daysLabel ?? label.replace(/\s*(outbound|return)\s*timetable/i, "").trim();
      continue;
    }
    if (!current || typeof label !== "string" || label.trim() === "") continue;
    const times = r.slice(1).filter((v) => v !== null && v !== "");
    if (times.length === 0) continue;
    blocks[current].push({ label: label.trim(), minutes: times.map(fracToMinutes) });
  }
  for (const d of ["outbound", "return"]) {
    if (!blocks[d]?.length) throw new Error(`No ${d} block found in sheet "${sheetName}"`);
  }

  function unwrapColumns(block) {
    const nCols = Math.max(...block.map((b) => b.minutes.length));
    for (let c = 0; c < nCols; c++) {
      let prev = null;
      for (const row of block) {
        let m = row.minutes[c];
        if (m === undefined) continue;
        if (prev !== null && m < prev - 12 * 60) m += 24 * 60;
        row.minutes[c] = m;
        prev = m;
      }
    }
    return nCols;
  }

  const nOut = unwrapColumns(blocks.outbound);
  const nRet = unwrapColumns(blocks.return);
  if (nOut !== nRet) throw new Error(`Outbound has ${nOut} columns but return has ${nRet}`);

  const outLast = blocks.outbound.filter((b) => !isDepotRow(b.label)).at(-1);
  const retFirst = blocks.return.filter((b) => !isDepotRow(b.label))[0];
  for (let c = 0; c < nOut; c++) {
    if (retFirst.minutes[c] < outLast.minutes[c]) {
      for (const row of blocks.return) if (row.minutes[c] !== undefined) row.minutes[c] += 24 * 60;
    }
  }

  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const report = [];

  function applyBlock(dirName, block) {
    const stops = fixture.directions[dirName].stops;
    const paxStops = stops.filter((s) => s.role !== "depot");
    const depotStop = stops.find((s) => s.role === "depot");
    const passengerRows = block.filter((b) => !isDepotRow(b.label));
    const depotRows = block.filter((b) => isDepotRow(b.label));
    if (passengerRows.length !== paxStops.length) {
      report.push(`WARN ${dirName}: sheet has ${passengerRows.length} passenger rows, fixture has ${paxStops.length} passenger stops`);
    }
    const byName = new Map(paxStops.map((s) => [norm(s._placemark ?? s.stopName), s]));
    for (const row of passengerRows) {
      const s = byName.get(norm(row.label));
      if (!s) {
        report.push(`UNMATCHED ${dirName} row "${row.label}"`);
        continue;
      }
      s.proposedTimes = row.minutes.map(toHHMM);
    }
    const depotRow = dirName === "outbound" ? depotRows[0] : depotRows.at(-1);
    if (depotStop && depotRow) depotStop.proposedTimes = depotRow.minutes.map(toHHMM);
    else if (depotStop) report.push(`NO TIMES ${dirName} depot "${depotStop.stopName}" (no depot row in sheet)`);
    else if (depotRow) report.push(`WARN ${dirName}: sheet has a depot row but the fixture has no role=depot stop (re-run import-route.js)`);
    for (const s of stops) if (!s.proposedTimes) report.push(`NO TIMES ${dirName} stop "${s._placemark ?? s.stopName}"`);
    return { passengerRows, depotRows };
  }

  const out = applyBlock("outbound", blocks.outbound);
  const ret = applyBlock("return", blocks.return);
  const firstOut = out.passengerRows[0];
  const firstRet = ret.passengerRows[0];
  const outDepot = out.depotRows[0];
  const retDepot = ret.depotRows.at(-1);

  fixture.timetableColumns = Array.from({ length: nOut }, (_, c) => ({
    columnId: `C${String(c + 1).padStart(2, "0")}`,
    outboundDeparture: toHHMM(firstOut.minutes[c]),
    returnDeparture: toHHMM(firstRet.minutes[c]),
    ...(outDepot ? { depotDeparture: toHHMM(outDepot.minutes[c]) } : {}),
    ...(retDepot ? { depotArrival: toHHMM(retDepot.minutes[c]) } : {}),
  }));

  if (fixture.depot && (outDepot || retDepot)) {
    fixture.depot.proposedTimes = {
      ...(outDepot ? { outboundDeparture: outDepot.minutes.map(toHHMM) } : {}),
      ...(retDepot ? { returnArrival: retDepot.minutes.map(toHHMM) } : {}),
    };
    fixture.depot.timetableLabel = (outDepot ?? retDepot).label;
  }
  fixture.daysOfOperation = daysLabel ?? null;
  fixture._source = {
    ...(fixture._source ?? {}),
    timetable: { file: path.relative(process.cwd(), xlsxPath), sheet: sheetName, importedAt: new Date().toISOString() },
  };

  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");

  console.error(`Sheet "${sheetName}" — ${daysLabel ?? "days n/a"} — ${nOut} columns`);
  console.error(`Depot label: ${(outDepot ?? retDepot)?.label ?? "none"}`);
  console.error("\nColumns (service-day notation; >24:00 = after midnight):");
  for (const c of fixture.timetableColumns) {
    const i = fixture.timetableColumns.indexOf(c);
    const outRun = outLast.minutes[i] - firstOut.minutes[i];
    const retLast = ret.passengerRows.at(-1).minutes[i];
    const layover = firstRet.minutes[i] - outLast.minutes[i];
    const retRun = retLast - firstRet.minutes[i];
    const duty = retDepot && outDepot ? retDepot.minutes[i] - outDepot.minutes[i] : null;
    console.error(
      `  ${c.columnId}  depot ${c.depotDeparture ?? "--:--"}  out ${c.outboundDeparture} → arr ${toHHMM(outLast.minutes[i])} (${outRun} min)  layover ${layover} min  ret ${c.returnDeparture} → arr ${toHHMM(retLast)} (${retRun} min)  depot ${c.depotArrival ?? "--:--"}${duty !== null ? `  duty ${Math.floor(duty / 60)}h${String(duty % 60).padStart(2, "0")}` : ""}`,
    );
  }
  if (report.length) {
    console.error("\nIssues:");
    report.forEach((r) => console.error("  " + r));
  } else console.error("\nAll stop rows matched.");
  console.error(`\nwrote ${fixturePath}`);
}
