/** @format */

import type { ViewProps } from "../App";
import type { Direction, EngineDocument, ODPair } from "../types";
import {
  Badge,
  DataTable,
  Empty,
  Feedback,
  Panel,
  Stat,
  type Column,
  type ConsiderationItem,
  type TableSection,
} from "../components/ui";
import {
  hasSupplyData,
  pairCompetitionLines,
  pairFreeFlowCoachMinutes,
  pairFreeFlowTimeRatio,
  pairHasCompetition,
  pathDetourWarnFromDocument,
  stopName,
  type PairCompetitionDay,
} from "../lib/derive";
import { isNum, num } from "../lib/format";

const TIME_RATIO_WARN = 1.5;

function competitionBadge(pair: ODPair, day: PairCompetitionDay) {
  if (pairHasCompetition(pair, day)) {
    const lines = pairCompetitionLines(pair, day);
    const title = lines.length ? lines.join(", ") : undefined;
    return (
      <span title={title}>
        <Badge kind="info">Served</Badge>
      </span>
    );
  }
  return <Badge kind="neutral">Unserved</Badge>;
}

function competitionCell(pair: ODPair, day: PairCompetitionDay, supplyKnown: boolean) {
  if (!supplyKnown) return <span className="muted">–</span>;
  const lines = pairCompetitionLines(pair, day);
  const title = lines.length ? lines.join(", ") : "Unserved";
  return <span title={title}>{competitionBadge(pair, day)}</span>;
}

function servedCoverage(pairs: ODPair[], day: PairCompetitionDay) {
  const served = pairs.filter((p) => pairHasCompetition(p, day)).length;
  const pct = pairs.length ? Math.round((served / pairs.length) * 100) : 0;
  return { served, pct };
}

function freeFlowTimeRatios(
  dir: Direction | undefined,
  pairs: ODPair[],
  doc: EngineDocument,
): number[] {
  return pairs
    .map((p) => pairFreeFlowTimeRatio(dir, p, doc))
    .filter(isNum)
    .sort((a, b) => a - b);
}

function medianFreeFlowTimeRatio(
  dir: Direction | undefined,
  pairs: ODPair[],
  doc: EngineDocument,
): number | null {
  const ratios = freeFlowTimeRatios(dir, pairs, doc);
  if (!ratios.length) return null;
  const mid = Math.floor(ratios.length / 2);
  const median =
    ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid];
  return Math.round(median * 100) / 100;
}

function coachFreeFlowTitle(
  dir: Direction | undefined,
  pair: ODPair,
  doc: EngineDocument,
): string | undefined {
  const coach = pairFreeFlowCoachMinutes(dir, pair, doc);
  if (!isNum(coach)) return undefined;
  const dwell = pair.dwellMinutesBetween;
  if (isNum(dwell) && dwell > 0) {
    const drive = Math.round((coach - dwell) * 10) / 10;
    return `${num(coach, 1)} min = ${num(drive, 1)} min driving + ${num(dwell, 1)} min intermediate dwell (static x per-leg factor)`;
  }
  return `${num(coach, 1)} min along the service route (static x per-leg factor)`;
}

export default function ODPairs({ doc, direction }: ViewProps) {
  const dir = doc.directions[direction];
  const pairs = dir?.directionalODPairs ?? [];
  const pathDetourWarn = pathDetourWarnFromDocument(doc);
  const withData = pairs.filter((p) => isNum(p.pathDetourRatio));
  const medianTime = medianFreeFlowTimeRatio(dir, withData, doc);
  const supplyKnown = hasSupplyData(doc);
  const weekday = servedCoverage(withData, "weekday");
  const weekend = servedCoverage(withData, "weekend");

  if (!withData.length) {
    return (
      <>
        <Feedback />
        <Empty>
          No stop-pair path metrics yet — run the engine with Google Route Matrix
          (pair-drive step after velocity).
        </Empty>
      </>
    );
  }

  const fromCol: Column<ODPair> = {
    key: "from",
    header: "From",
    render: (p) => stopName(dir, p.originStopId),
    wrap: true,
  };
  const toCol: Column<ODPair> = {
    key: "to",
    header: "To",
    render: (p) => stopName(dir, p.destinationStopId),
    wrap: true,
  };
  const distanceCol: Column<ODPair> = {
    key: "pathRatio",
    header: "Distance",
    title: isNum(pathDetourWarn)
      ? `Service route km ÷ direct car km (Route Matrix). Road distance only — not traffic-dependent. > ${num(pathDetourWarn, 2)} is flagged.`
      : "Service route km ÷ direct car km (Route Matrix). Road distance only — not traffic-dependent.",
    render: (p) => {
      const r = p.pathDetourRatio;
      if (!isNum(r)) return "–";
      const hover =
        isNum(p.coachPathKm) && isNum(p.directCarKm)
          ? `${num(p.coachPathKm, 2)} km ÷ ${num(p.directCarKm, 2)} km = ${num(r, 2)}`
          : undefined;
      return <span title={hover}>{num(r, 2)}</span>;
    },
    num: true,
  };
  const timeCol: Column<ODPair> = {
    key: "timeRatio",
    header: "Time",
    title: `Coach free-flow min (static x per-leg carriageway factor + dwell) ÷ direct car free-flow min. > ${num(TIME_RATIO_WARN, 1)} is flagged.`,
    render: (p) => {
      const r = pairFreeFlowTimeRatio(dir, p, doc);
      if (!isNum(r)) return "–";
      const coach = pairFreeFlowCoachMinutes(dir, p, doc);
      const car = p.directCarStaticDriveMinutes;
      const hover =
        isNum(coach) && isNum(car)
          ? `${num(coach, 1)} min ÷ ${num(car, 1)} min = ${num(r, 2)}`
          : undefined;
      return (
        <span
          title={hover}
          style={
            r > TIME_RATIO_WARN ? { color: "var(--warn)", fontWeight: 600 } : undefined
          }
        >
          {num(r, 2)}
        </span>
      );
    },
    num: true,
  };
  const carCol: Column<ODPair> = {
    key: "carMin",
    header: "Car",
    unit: "min",
    title: "Direct A→B free-flow drive minutes (Route Matrix staticDuration)",
    render: (p) => num(p.directCarStaticDriveMinutes, 1),
    num: true,
  };
  const coachCol: Column<ODPair> = {
    key: "coach",
    header: "Coach",
    unit: "min",
    title:
      "In-vehicle along the service route: Google static x per-leg coach factor, incl. intermediate dwell",
    render: (p) => {
      const coach = pairFreeFlowCoachMinutes(dir, p, doc);
      if (!isNum(coach)) return "–";
      return <span title={coachFreeFlowTitle(dir, p, doc)}>{num(coach, 1)}</span>;
    },
    num: true,
  };
  const weekdayCol: Column<ODPair> = {
    key: "competitionWeekday",
    header: "Weekday",
    title: "Overlapping BODS / TNDS lines on weekday reference day (Tue–Thu)",
    render: (p) => competitionCell(p, "weekday", supplyKnown),
  };
  const weekendCol: Column<ODPair> = {
    key: "competitionWeekend",
    header: "Weekend",
    title: "Overlapping BODS / TNDS lines on Saturday weekend profile",
    render: (p) => competitionCell(p, "weekend", supplyKnown),
  };

  const sections: TableSection<ODPair>[] = [
    { kind: "columns", columns: [fromCol, toCol] },
    { kind: "group", header: "Detour ratio", columns: [distanceCol, timeCol] },
    { kind: "group", header: "Free-flow travel time", columns: [carCol, coachCol] },
    {
      kind: "group",
      header: "Competitor coverage",
      columns: [weekdayCol, weekendCol],
    },
  ];

  return (
    <>
      <Feedback
        feedback="The stop pairs table show every origin-destination pair the proposed route served. Detour ratios vary widely with a median free-flow coach-to-car time ratio of 1.48, meaning coach trips take roughly 50% longer than driving even in optimal, traffic-free conditions. This sits above the 1.25x band where mode-share conversion typically holds. Most pairs are unserved by direct competitors at 23%, but unserved does not mean valuable. Cross-reference this tab with Route & stops to judge whether slow pairs justify their anchor stops or should be cut. Time deviation ≥1.5x is flagged in amber in the stop pairs table."
        improvements={[
          "Examine top detour contributors: East Flemington (Nr) and Blindwells South (at) recur among the worst detour ratios, cross-check each against Route & stops. If an anchor stop driving a high ratio also has low catchment and weak POI gravity, drop or reposition it.",
          "Unserved pairs are not necessarily valuable: Do not blindly keep stops pairs purely because they are unserved. Use the stop-level catchment and POI gravity data to verify whether stops in unserved pairs represent genuine untapped market demand or merely empty geographic coverage.",
          "Keep overall time ratios close to ~1.25x: Transport demand models show passenger conversion drops off sharply once coach travel time drifts past 1.30x to 1.50x direct car time.",
        ]}
        considerations={
          [
            {
              label: "Pair weighting",
              text: "The median pair ratio treats every journey equally. In practice, pairs differ in revenue potential and should not be weighted the same when judging competitiveness.",
            },
            {
              label: "Traffic-window ratios",
              text: "Time ratio currently compares free-flow travel times. Traffic-window variants would further improve peak vs off-peak mode-choice review.",
            },
            {
              label: "Stop aliasing",
              text: "Competitor supply only matches exact NaPTAN codes OD pairing. Also linking codes within 10-minute walk catchment of our stops would surface more competing lines that are currently marked as unserved.",
            },
            {
              label: "Rail competition",
              text: "ORR data could expose data for comparing pairs against parallel rail routes. There may be opportunities to capture cost-conscious passengers switching from rail to coach, especially when rail prices rise.",
            },
            {
              label: "Census OD flows",
              text: "Travel-to-work origin-destination census data could show genuine daily travel flows per OD pair rather than static population counts alone. Initial review shows that data mapping (MSOA to LSOA) for cross border journeys seems too coarse and 2021/2022 data also requires correction for lockdown but still worth exploring.",
            },
          ] satisfies ConsiderationItem[]
        }
      />
      <Panel title={`Stop pairs`}>
        <div className="stats margin-bottom-12">
          <Stat
            compact
            label="Stop pairs"
            value={withData.length}
            sub={`Unique journeys`}
          />
          <Stat
            compact
            label="Median pair ratio"
            value={isNum(medianTime) ? num(medianTime, 2) : "–"}
            sub="Free-flow coach min ÷ direct car min"
          />
          <Stat
            compact
            label="Weekday competitor coverage"
            dayType="weekday"
            value={supplyKnown ? `${weekday.pct}%` : "–"}
            sub={
              supplyKnown
                ? `${weekday.served}/${withData.length} journeys with competing lines`
                : "Pending BODS / TNDS ingestion"
            }
          />
          <Stat
            compact
            label="Weekend competitor coverage"
            dayType="weekend"
            value={supplyKnown ? `${weekend.pct}%` : "–"}
            sub={
              supplyKnown
                ? `${weekend.served}/${withData.length} journeys with competing lines`
                : "Pending BODS / TNDS ingestion"
            }
          />
        </div>
        <DataTable
          rows={[...withData].sort(
            (a, b) =>
              (pairFreeFlowTimeRatio(dir, b, doc) ?? 0) -
              (pairFreeFlowTimeRatio(dir, a, doc) ?? 0),
          )}
          sections={sections}
          rowKey={(p) => p.pairId}
          maxHeight={480}
        />
      </Panel>
    </>
  );
}
