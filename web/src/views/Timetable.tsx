/** @format */

import { useEffect, useMemo, useState } from "react";
import type { ViewProps } from "../App";
import type {
  CompetitorDeparture,
  HeadwayGap,
  ODPair,
  TimetableDisplayRow,
} from "../types";
import {
  Check,
  DataTable,
  Empty,
  Feedback,
  Panel,
  Seg,
  Stat,
  type Column,
  type ConsiderationItem,
} from "../components/ui";
import { TimetableGroupedGrid } from "../components/TimetableBoard";
import {
  deadLegAllowances,
  departuresPerService,
  hasSupplyData,
  headwayGapDepartingLine,
  headwayGapThresholdFromDocument,
  proposedTimetableRows,
  slotCandidateRows,
  slotSelectedRows,
  stopName,
  type TimetableDay,
} from "../lib/derive";
import { fleetVehicleRange, type ScheduleColumn } from "../lib/fleet-schedule";
import {
  buildProposedTimetableBoardGrouped,
  buildSuggestedTimetableBoardGrouped,
} from "../lib/timetable-board";
import { displayServiceTime, duration, isNum, num, parseHHMM } from "../lib/format";

type AuditSource = "proposed" | "suggested";

/** Proposed timetable service count for gap-hit comparison. */
const COMPARE_SERVICE_COUNT = 8;
/** Recommended initial launch band for suggested scheduling stats. */
const LAUNCH_MIN = 3;
const LAUNCH_MAX = 5;

function cumulativeHitsAt(rows: TimetableDisplayRow[], n: number): number | null {
  const hits = rows[Math.min(n, rows.length) - 1]?.cumulativeGapHits;
  return isNum(hits) ? hits : null;
}

function hitsBandRange(
  rows: TimetableDisplayRow[],
  minN: number,
  maxN: number,
): { range: string; sub: string } | null {
  if (!rows.length) return null;
  const lowN = Math.min(minN, rows.length);
  const highN = Math.min(maxN, rows.length);
  const low = cumulativeHitsAt(rows, lowN);
  const high = cumulativeHitsAt(rows, highN);
  if (!isNum(low) || !isNum(high)) return null;
  const min = Math.min(low, high);
  const max = Math.max(low, high);
  const full = rows.at(-1)?.cumulativeGapHits;
  return {
    range: min === max ? num(min) : `${num(min)}–${num(max)}`,
    sub:
      isNum(full) && rows.length > highN
        ? `${lowN}–${highN} services · ${num(full)} for all ${rows.length}`
        : `${lowN}–${highN} gap-ranked services`,
  };
}

function fleetBandRange(
  doc: Parameters<typeof deadLegAllowances>[0],
  fleet: NonNullable<ViewProps["doc"]["fleet"]>,
  rows: TimetableDisplayRow[],
  minN: number,
  maxN: number,
) {
  if (!rows.length) return null;
  const lowN = Math.min(minN, rows.length);
  const highN = Math.min(maxN, rows.length);
  const counts: number[] = [];
  for (const n of new Set([lowN, highN])) {
    const f = fleetVehicleRange(
      fleet,
      timetableRowsToFleetColumns(doc, rows.slice(0, n)),
    );
    if (f) counts.push(f.min, f.max);
  }
  if (!counts.length) return null;
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const atLow = fleetVehicleRange(
    fleet,
    timetableRowsToFleetColumns(doc, rows.slice(0, lowN)),
  );
  const atHigh =
    highN !== lowN
      ? fleetVehicleRange(fleet, timetableRowsToFleetColumns(doc, rows.slice(0, highN)))
      : null;
  const cableNote =
    atLow &&
    isNum(atLow.min) &&
    isNum(atLow.max) &&
    atLow.min !== atLow.max &&
    atLow.sub !== "dependent on cable availability"
      ? atLow.sub
      : null;
  return {
    range: min === max ? String(min) : `${min}–${max}`,
    sub:
      cableNote ??
      (atHigh && atLow
        ? `${atLow.range} at ${lowN} · ${atHigh.range} at ${highN} services`
        : `${lowN}–${highN} services`),
  };
}

function timetableRowsToFleetColumns(
  doc: Parameters<typeof deadLegAllowances>[0],
  rows: TimetableDisplayRow[],
): ScheduleColumn[] {
  const dead = deadLegAllowances(doc);
  return rows
    .map((r) => {
      const depotDeparture = parseHHMM(r.outboundDeparture);
      const depotArrival = parseHHMM(r.returnArrival);
      if (depotDeparture == null || depotArrival == null) return null;
      return {
        columnId: r.columnId,
        depotDeparture: depotDeparture - dead.out,
        depotArrival: depotArrival + dead.in,
      };
    })
    .filter((c): c is ScheduleColumn => c != null);
}

function timetableTableColumns(mode: "audit" | "ranked"): Column<TimetableDisplayRow>[] {
  const idColumn: Column<TimetableDisplayRow> = {
    key: "id",
    header: mode === "ranked" ? "Rank" : "Service",
    title:
      mode === "ranked"
        ? "Standalone gap-hit rank on competitor-only timelines"
        : undefined,
    render: (r) => (mode === "ranked" ? <b>{r.rank ?? "–"}</b> : <b>{r.columnId}</b>),
  };
  const timeColumns: Column<TimetableDisplayRow>[] = [
    {
      key: "od",
      header: "Out dep",
      render: (r) => displayServiceTime(r.outboundDeparture),
    },
    {
      key: "oa",
      header: "Out arr",
      render: (r) => displayServiceTime(r.outboundArrival),
    },
    {
      key: "lay",
      header: "Layover",
      render: (r) => (r.layoverMinutes != null ? duration(r.layoverMinutes) : "–"),
      num: true,
    },
    {
      key: "rd",
      header: "Ret dep",
      render: (r) => displayServiceTime(r.returnDeparture),
    },
    { key: "ra", header: "Ret arr", render: (r) => displayServiceTime(r.returnArrival) },
  ];
  const gapHitColumns: Column<TimetableDisplayRow>[] = [
    {
      key: "outHits",
      header: "Out gaps",
      title:
        "Stop pairs where this column's outbound departure at the journey origin falls in a peak candidate slot",
      render: (r) =>
        r.outboundPairsInOpenings != null ? r.outboundPairsInOpenings : "–",
      num: true,
    },
    {
      key: "retHits",
      header: "Ret gaps",
      title:
        "Stop pairs where this column's return departure at the journey origin falls in a peak candidate slot",
      render: (r) => (r.returnPairsInOpenings != null ? r.returnPairsInOpenings : "–"),
      num: true,
    },
  ];
  const totalGapColumn: Column<TimetableDisplayRow> = {
    key: "totalHits",
    header: "Total gap hits",
    title:
      mode === "ranked"
        ? "Stop pairs whose departure falls in a peak candidate slot (standalone score)"
        : "Stop pairs whose departure falls in a peak candidate slot (incremental after earlier columns)",
    render: (r) => (r.pairsInOpenings != null ? r.pairsInOpenings : "–"),
    num: true,
  };
  const cumulativeColumn: Column<TimetableDisplayRow> = {
    key: "cumHits",
    header: "Cumulative",
    title: "Running total of incremental pair hits",
    render: (r) => (r.cumulativeGapHits != null ? r.cumulativeGapHits : "–"),
    num: true,
  };
  if (mode === "audit")
    return [idColumn, ...timeColumns, ...gapHitColumns, totalGapColumn, cumulativeColumn];
  return [idColumn, ...timeColumns, ...gapHitColumns, totalGapColumn];
}

function renderDepartingLine(services: string[], edgeLabel: string | null) {
  if (services.length) return services.join(", ");
  if (edgeLabel) return <span className="muted">{edgeLabel}</span>;
  return "–";
}

function HeadwayGapsTable({
  gaps,
  departures,
  headwayGapMin,
}: {
  gaps: HeadwayGap[];
  departures: CompetitorDeparture[];
  headwayGapMin: number | null;
}) {
  const peakSlotTitle = isNum(headwayGapMin)
    ? `Headway ≥ ${headwayGapMin} min and gap falls within a WebTRIS peak traffic band`
    : "Gap falls within a WebTRIS peak traffic band and meets the headway threshold";
  if (!gaps.length) return null;
  return (
    <div className="table-wrap">
      <table className="data headway-gaps">
        <thead>
          <tr>
            <th title="Competitor line departing when the window closes — or last line of day">
              Line
            </th>
            <th title="When the window opens — previous competitor departure or start of day">
              Departs
            </th>
            <th title="When the window closes — next competitor departure or end of day">
              Upcoming arrival
            </th>
            <th className="num" title="Minutes between opens and closes">
              Headway<span className="col-unit">min</span>
            </th>
            <th title={peakSlotTitle}>
              {isNum(headwayGapMin)
                ? `Headway ≥ ${headwayGapMin} min & in peak band`
                : "Peak slot?"}
            </th>
          </tr>
        </thead>
        <tbody>
          {gaps.map((gap, i) => {
            const line = headwayGapDepartingLine(gap, departures);
            return (
              <tr key={`${gap.gapStart}-${gap.gapEnd}-${i}`}>
                <td>{renderDepartingLine(line.services, line.edgeLabel)}</td>
                <td>{gap.gapStart ?? "–"}</td>
                <td>{gap.gapEnd ?? "–"}</td>
                <td className="num">{duration(gap.durationMinutes)}</td>
                <td>
                  <Check ok={gap.isMarketOpening} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Timetable({ doc, direction }: ViewProps) {
  const [auditSource, setAuditSource] = useState<AuditSource>("proposed");
  const [timetableSource, setTimetableSource] = useState<AuditSource>("proposed");
  const [day, setDay] = useState<TimetableDay>("weekday");
  const [showAllCandidates, setShowAllCandidates] = useState(false);
  const dir = doc.directions[direction];
  const pairs = dir?.directionalODPairs ?? [];
  const supply = hasSupplyData(doc);
  const headwayGapMin = headwayGapThresholdFromDocument(doc);
  const pairsWithSupply = useMemo(
    () =>
      [...pairs].sort((a, b) => {
        const al = a.supplyVector?.detectedOverlappingLines?.length ?? 0;
        const bl = b.supplyVector?.detectedOverlappingLines?.length ?? 0;
        return bl - al || a.pairId.localeCompare(b.pairId);
      }),
    [pairs],
  );
  const [pairId, setPairId] = useState<string>("");

  const proposedRows = useMemo(() => proposedTimetableRows(doc, day), [doc, day]);
  const slotCandidates = useMemo(() => slotCandidateRows(doc, day), [doc, day]);
  const slotSelected = useMemo(() => slotSelectedRows(doc, day), [doc, day]);
  const slotSelectedWeekday = useMemo(() => slotSelectedRows(doc, "weekday"), [doc]);
  const slotSelectedWeekend = useMemo(() => slotSelectedRows(doc, "weekend"), [doc]);
  const launchSlice = (rows: TimetableDisplayRow[]) => rows.slice(0, LAUNCH_MAX);
  const proposedGroupedBoard = useMemo(
    () => buildProposedTimetableBoardGrouped(doc, direction, LAUNCH_MAX),
    [doc, direction],
  );
  const suggestedGroupedBoard = useMemo(
    () =>
      buildSuggestedTimetableBoardGrouped(
        doc,
        direction,
        launchSlice(slotSelectedWeekday),
        launchSlice(slotSelectedWeekend),
      ),
    [doc, direction, slotSelectedWeekday, slotSelectedWeekend],
  );
  const compareCount = Math.min(COMPARE_SERVICE_COUNT, proposedRows.length);
  const proposedFleet = useMemo(() => {
    const fleet = doc.fleet;
    if (!fleet) return null;
    return fleetVehicleRange(fleet, timetableRowsToFleetColumns(doc, proposedRows));
  }, [doc, proposedRows]);
  const suggestedLaunchHits = useMemo(
    () => hitsBandRange(slotSelected, LAUNCH_MIN, LAUNCH_MAX),
    [slotSelected],
  );
  const suggestedLaunchFleet = useMemo(() => {
    const fleet = doc.fleet;
    if (!fleet) return null;
    return fleetBandRange(doc, fleet, slotSelected, LAUNCH_MIN, LAUNCH_MAX);
  }, [doc, slotSelected]);

  const proposedGapTotal =
    proposedRows[compareCount - 1]?.cumulativeGapHits ??
    proposedRows.at(-1)?.cumulativeGapHits;
  const showingCandidates = auditSource === "suggested" && showAllCandidates;
  const tableMode = showingCandidates ? "ranked" : "audit";
  const tableRows = useMemo(() => {
    if (auditSource === "proposed") return proposedRows;
    if (showAllCandidates) return slotCandidates;
    return slotSelected;
  }, [auditSource, showAllCandidates, proposedRows, slotCandidates, slotSelected]);

  useEffect(() => {
    setShowAllCandidates(false);
  }, [auditSource, day]);

  const pair: ODPair | undefined =
    pairsWithSupply.find((p) => p.pairId === pairId) ?? pairsWithSupply[0];
  const sv = pair?.supplyVector;
  const isWeekend = day === "weekend";
  const pairGaps = isWeekend
    ? (sv?.saturdayHeadwayGaps ?? [])
    : (sv?.calculatedHeadwayGaps ?? []);
  const pairDeps = isWeekend
    ? (sv?.saturdayCompetitorDepartures ?? [])
    : (sv?.competitorDepartures ?? []);
  const overlapLines = isWeekend
    ? sv?.saturdayDetectedOverlappingLines
    : sv?.detectedOverlappingLines;
  const lineRows = useMemo(
    () => departuresPerService(overlapLines, pairDeps),
    [overlapLines, pairDeps],
  );
  const gapsDayLabel = isWeekend ? "weekend" : "weekday";

  const marketGapsPanel = (
    <Panel
      title="Competitor gap"
      headerAction={
        <div className="timetable-audit-source market-gaps-header">
          <label className="control market-gaps-pair">
            <span className="control-label">Pair</span>
            <select value={pair?.pairId} onChange={(e) => setPairId(e.target.value)}>
              {pairsWithSupply.map((p) => {
                const lines = p.supplyVector?.detectedOverlappingLines?.length ?? 0;
                const label = `${stopName(dir, p.originStopId)} → ${stopName(dir, p.destinationStopId)}`;
                return (
                  <option key={p.pairId} value={p.pairId}>
                    {lines ? label : `${label} (no BODS overlap)`}
                  </option>
                );
              })}
            </select>
          </label>
          <Seg
            value={day}
            onChange={setDay}
            options={[
              { value: "weekday", label: "Weekday", swatch: "var(--weekday)" },
              { value: "weekend", label: "Weekend", swatch: "var(--weekend)" },
            ]}
          />
        </div>
      }
    >
      {!supply ? (
        <Empty>
          Competitor timetables (BODS / TNDS / coach feed) have not been ingested for this
          scenario. When present, this panel lists overlapping lines per pair, their
          departures, and peak candidate slot windows.
        </Empty>
      ) : (
        <>
          {pair && (
            <div className="market-gaps-headway" style={{ marginTop: 10 }}>
              {lineRows.length > 0 ? (
                <p className="small market-gaps-service-summary">
                  {lineRows.length} line{lineRows.length === 1 ? "" : "s"} serving this
                  journey with {pairDeps.length} departures per day
                </p>
              ) : (
                <p className="small muted" style={{ marginBottom: 8 }}>
                  No BODS/TNDS journey serves both stops pair on{" "}
                  {gapsDayLabel.toLowerCase()}.
                </p>
              )}

              <div className="headway-gaps-table">
                {pairGaps.length > 0 ? (
                  <HeadwayGapsTable
                    gaps={pairGaps}
                    departures={pairDeps}
                    headwayGapMin={headwayGapMin}
                  />
                ) : (
                  <p className="small muted headway-gaps-table-empty">
                    No headway gaps for this pair on {gapsDayLabel.toLowerCase()}.
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );

  return (
    <>
      <Feedback
        feedback="The competitor gap table surfaces market openings for each stop pair on the prposed route. An opening is a gap of ≥60 min in a peak traffic band where no competitor serves. The timetable audit scores each service against that supply. For the proposed timetable, gap coverage rises quickly on the first services, then flattens as later departures add little. Use time table audit table below to compare the proposed schedule with suggested service candidates."
        improvements={[
          "Start new-route lean: launch with 3–5 high-impact services before scaling up. The suggested model ranks chainable round-trips by combined gap hits; the first few services capture most peak openings, while later slots add diminishing coverage. Gap presence does not equal demand — keep initial frequency tight to protect margins and validate real-world load.",
          "Examine services yielding zero gap coverage: C07 and C08 service add zero incremental gap coverage, if timetable is to kept the same, reallocate those vehicle hours toward intermediate peak windows where competitor gaps remain unserved. Even small departure, layover and return time shifting could improve gap hit.",
          "Initial launch: if the route opens with 5 services, prefer the suggested over the proposed timetable as they requires the same fleet size but has higher gap coverage while also has departures and leg times derived from traffic-band-adjusted running times.",
          "Improve granularity: If the suggested model is sound, shift departure and layover simulation steps from 15-minute to 1-minute intervals. Finer resolution will unlock tighter pairings and align departures more precisely with peak demand windows.",
        ]}
        considerations={
          [
            {
              label: "Lookahead scheduling",
              text: "Suggested services are picked one at a time by gap coverage. A fuller model would choose the best set of departures together, balancing competitor gaps against how many buses are needed and whether outbound/return times chain cleanly on the same vehicle.",
            },
          ] satisfies ConsiderationItem[]
        }
      />
      {marketGapsPanel}
      <Panel
        title="Timetable audit"
        // sub={`${dayLabel} · ${competitorLabel} supply · gap hits per service column`}
        headerAction={
          <div className="timetable-audit-source">
            {auditSource === "suggested" && slotCandidates.length > 0 && (
              <label className="timetable-audit-show-candidates">
                <input
                  type="checkbox"
                  checked={showAllCandidates}
                  onChange={(e) => setShowAllCandidates(e.target.checked)}
                />{" "}
                Show all ranked options ({slotCandidates.length})
              </label>
            )}
            <Seg
              value={auditSource}
              onChange={setAuditSource}
              options={[
                { value: "proposed", label: "Proposed" },
                { value: "suggested", label: "Suggested scheduling" },
              ]}
            />
            <Seg
              value={day}
              onChange={setDay}
              options={[
                { value: "weekday", label: "Weekday", swatch: "var(--weekday)" },
                { value: "weekend", label: "Weekend", swatch: "var(--weekend)" },
              ]}
            />
          </div>
        }
        tight
      >
        <div className="timetable-audit-bar">
          <div className="stats timetable-audit-stats">
            {auditSource === "proposed" && (
              <Stat
                compact
                label="Proposed # of services"
                value={proposedRows.length}
                sub="Mon-Sun pattern"
              />
            )}
            {auditSource === "suggested" && (
              <Stat
                compact
                label="Suggested # of services to launch"
                value={`${LAUNCH_MIN}–${LAUNCH_MAX}`}
                sub="start lean to test market demand"
              />
            )}
            <Stat
              compact
              label="Cumulative gap hits"
              value={
                auditSource === "proposed"
                  ? proposedGapTotal != null
                    ? num(proposedGapTotal)
                    : "–"
                  : (suggestedLaunchHits?.range ?? "–")
              }
              sub={
                auditSource === "proposed"
                  ? `first ${compareCount} services`
                  : (suggestedLaunchHits?.sub ?? "–")
              }
            />
            <Stat
              compact
              label="Required vehicles"
              value={
                auditSource === "proposed"
                  ? (proposedFleet?.range ?? "–")
                  : (suggestedLaunchFleet?.range ?? "–")
              }
              sub={
                auditSource === "proposed"
                  ? (proposedFleet?.sub ?? "dependent on cable availability")
                  : (suggestedLaunchFleet?.sub ?? "dependent on cable availability")
              }
            />
          </div>
        </div>
        <div className="timetable-audit-table">
          {tableRows.length > 0 ? (
            <DataTable
              rows={tableRows}
              columns={timetableTableColumns(tableMode)}
              rowKey={(r) => {
                if (showingCandidates) {
                  return `rank-${r.rank}-${r.outboundDeparture}-${r.layoverMinutes}`;
                }
                return auditSource === "proposed" ? r.columnId : `sel-${r.columnId}`;
              }}
            />
          ) : (
            <p className="small muted timetable-audit-table-empty">
              {auditSource === "proposed"
                ? "No proposed timetable columns in this scenario."
                : showingCandidates
                  ? "Ranked options appear once supply and timetable-selection have run."
                  : "Gap-ranked selection appears once supply and timetable-selection have run."}
            </p>
          )}
        </div>
      </Panel>
      <Panel
        title="Timetable proposal"
        headerAction={
          <Seg
            value={timetableSource}
            onChange={setTimetableSource}
            options={[
              { value: "proposed", label: "Proposed" },
              { value: "suggested", label: "Suggested" },
            ]}
          />
        }
        tight
      >
        {timetableSource === "proposed" ? (
          proposedGroupedBoard ? (
            <TimetableGroupedGrid board={proposedGroupedBoard} />
          ) : (
            <p className="small muted">No proposed timetable in this scenario.</p>
          )
        ) : suggestedGroupedBoard ? (
          <TimetableGroupedGrid board={suggestedGroupedBoard} />
        ) : (
          <p className="small muted">
            Gap-ranked selection appears once supply and timetable-selection have run.
          </p>
        )}
      </Panel>
    </>
  );
}
