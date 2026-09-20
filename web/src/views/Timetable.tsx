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
import {
  departuresPerService,
  hasSupplyData,
  headwayGapDepartingLine,
  headwayGapThresholdFromDocument,
  proposedTimetableRows,
  slotCandidateRows,
  slotRankingMeta,
  slotSelectedRows,
  stopName,
  type TimetableDay,
} from "../lib/derive";
import { displayServiceTime, duration, isNum, num } from "../lib/format";

type AuditSource = "proposed" | "suggested";

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
  const slotMeta = useMemo(() => slotRankingMeta(doc, day), [doc, day]);
  const proposedGapTotal = proposedRows.at(-1)?.cumulativeGapHits;
  const suggestedGapTotal = slotSelected.at(-1)?.cumulativeGapHits;
  const auditGapTotal = auditSource === "proposed" ? proposedGapTotal : suggestedGapTotal;
  const competitorLabel = day === "weekday" ? "weekday BODS" : "weekend BODS";
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
        feedback="The proposed timetable was audited against competitor departures for unserved peak gaps and outbound/return pairings. Cumulative gap coverage rises quickly with the first services but flattens: see the audit table and headway map below for where each column lands and how much incremental value later departures add."
        improvements={[
          "The suggested improvement model identifies up to 12 candidate services to absorb all remaining market gaps; start operations with a lean schedule of 3 to 5 high-impact trips. Services S01, S04, and S05 account for the vast majority of peak gap hits. Cap initial launch frequency to protect operating margins and test real-world demand.",
          "Shift departure and layover simulation steps from 15-minute to 1-minute intervals. Finer resolution will unlock tighter pairings, and align departures more precisely with peak demand windows.",
          "Remove services like C07 and C08 that yield zero incremental gap coverage. Reallocate those vehicle hours toward intermediate peak windows where competitor gaps remain unserved.",
        ]}
        considerations={
          [
            {
              label: "Fleet-fit subset search",
              text: "Step 2 fleet-fit: re-score discovered columns standalone (not greedy pick-order marginals), then choose the highest-demand subset that fits the fleet cap via exhaustive search + block scheduler. Avoids dropping a weak second pick that still pairs well in the Gantt.",
            },
            {
              label: "Lookahead scheduling",
              text: "Candidate services are added sequentially based on greedy individual rank. Implementing a forward-looking optimization model would evaluate full schedule combinations and prevent early trip selections from blocking superior downstream vehicle pairings.",
            },
            {
              label: "Layover search",
              text: "Per outbound departure, search layover length so the return leg lands in the best far-end market opening (design doc layover lever), not only a fixed {45, 60, 75, 90} min grid.",
            },
            {
              label: "Launch",
              text: "Recalibrate proposed vs expected segment times using observed boarding and running times once departures are live.",
            },
            {
              label: "Weekend running times",
              text: "Score weekend columns against AM, off-peak and PM running times, not only a single mid-day traffic snapshot (weekend competitor + peak-filtered openings are scored today).",
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
            <Seg
              value={auditSource}
              onChange={setAuditSource}
              options={[
                { value: "proposed", label: "Proposed" },
                { value: "suggested", label: "Suggested Improvements" },
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
                label="Suggested # of services"
                value={slotSelected.length || "–"}
                sub={slotMeta.stopReason?.replace(/_/g, " ") ?? "gap-ranked selection"}
              />
            )}
            <Stat
              compact
              label="Cumulative gap hits"
              value={auditGapTotal != null ? num(auditGapTotal) : "–"}
              sub={
                auditGapTotal != null
                  ? `incremental vs ${competitorLabel}`
                  : "pending timetable-selection step"
              }
            />
            <Stat
              compact
              label="Vehicles"
              value={
                auditSource === "suggested"
                  ? (slotMeta.vehiclesRequired ?? "–")
                  : (slotMeta.proposalVehicles ?? "–")
              }
              sub={
                auditSource === "suggested" && slotMeta.proposalVehicles != null
                  ? `proposed uses ${slotMeta.proposalVehicles}`
                  : "block scheduler"
              }
            />
          </div>
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
    </>
  );
}
