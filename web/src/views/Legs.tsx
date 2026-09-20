/** @format */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ViewProps } from "../App";
import type { Leg, Stop, TrafficSampleId } from "../types";
import TrafficWindowsPanel, {
  hasTrafficWindowsData,
} from "../components/TrafficWindowsPanel";
import {
  Badge,
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
  carriagewayKindLabel,
  coachLegMin,
  documentDwellSeconds,
  layoverStopId,
  legCarriagewayKind,
  legDeltaMin,
  legDepartureDwellSeconds,
  legModelledTotalMin,
  legRowLabel,
  freeFlowEndToEndService,
  modelledEndToEndServiceSample,
  proposedEndToEndService,
  sampleLabel,
  serviceTemporalWindows,
  stopName,
  type TimetableDay,
  weekdayTrafficSampleIds,
  weekendTrafficSampleIds,
} from "../lib/derive";
import { duration, isNum, num, signed } from "../lib/format";

/** Modelled − proposed: how many minutes longer the model needs than the timetable allows. */
function deltaShortfallStyle(shortfall: number): CSSProperties | undefined {
  if (shortfall > 5) return { color: "var(--bad)", fontWeight: 600 };
  if (shortfall > 0) return { color: "var(--warn)", fontWeight: 600 };
  return undefined;
}

function renderE2eDelta(shortfall: number | null) {
  if (!isNum(shortfall)) return "–";
  return <span style={deltaShortfallStyle(shortfall)}>Δ {signed(shortfall, 1)} min</span>;
}

function sampleDeparture(
  doc: ViewProps["doc"],
  sampleId: TrafficSampleId,
  direction: ViewProps["direction"],
): string {
  const tw = serviceTemporalWindows(doc.estimatedTemporalWindows, direction);
  if (sampleId === "weekend") {
    return tw?.weekendDeparture ? `Saturday ${tw.weekendDeparture}` : "Saturday 11:00";
  }
  const band = tw?.weekdayBands?.find((b) => b.id === sampleId);
  return `Tuesday ${band?.apex}`;
}

export default function Legs({ doc, direction }: ViewProps) {
  const dir = doc.directions[direction];
  const legs = dir?.legs ?? [];
  const stops = dir?.orderedStops ?? [];
  const docDwell = documentDwellSeconds(dir);
  const [dayType, setDayType] = useState<TimetableDay>("weekday");
  const weekdaySamples = useMemo(
    () =>
      weekdayTrafficSampleIds(
        doc.estimatedTemporalWindows,
        direction,
      ) as TrafficSampleId[],
    [doc.estimatedTemporalWindows, direction],
  );
  const weekendSamples = useMemo(
    () => weekendTrafficSampleIds() as TrafficSampleId[],
    [],
  );
  const activeSamples = dayType === "weekday" ? weekdaySamples : weekendSamples;
  const defaultSample = (activeSamples[0] ?? "weekend") as TrafficSampleId;
  const [sample, setSample] = useState<TrafficSampleId>(defaultSample);
  const [dwellSec, setDwellSec] = useState(docDwell);

  useEffect(() => {
    setSample((activeSamples[0] ?? "weekend") as TrafficSampleId);
  }, [direction, dayType, activeSamples]);
  useEffect(() => {
    setDwellSec(documentDwellSeconds(dir));
  }, [dir]);
  const layover = layoverStopId(dir, direction);
  const stopById = (id: string) => stops.find((s) => s.naptanId === id);
  const dwellForLeg = (l: Leg) =>
    legDepartureDwellSeconds(l, stopById(l.fromStopId), direction, layover, dwellSec);

  const showTrafficWindows = hasTrafficWindowsData(doc, direction);
  const prop = proposedEndToEndService(dir, direction);
  const freeFlow = freeFlowEndToEndService(dir, direction, dwellSec, doc);
  const freeFlowDelta = isNum(freeFlow) && isNum(prop) ? freeFlow - prop : null;
  const dwellOptions = [...new Set([0, 30, docDwell].filter((v) => v >= 0))].sort(
    (a, b) => a - b,
  );

  const kindBadge = (kind: Stop["carriagewayKind"] | undefined) => {
    const label = carriagewayKindLabel(kind);
    if (!label) return "–";
    const tone: "neutral" | "warn" | "info" =
      kind === "single" ? "warn" : kind === "dual" ? "info" : "neutral";
    return <Badge kind={tone}>{label}</Badge>;
  };

  const columnsFor = (id: TrafficSampleId): Column<Leg>[] => [
    {
      key: "n",
      header: "#",
      rowNum: true,
      title: "D = depot run; passenger segments numbered 1…n in route order",
      render: (_l, i) => legRowLabel(legs, i),
      num: true,
    },
    {
      key: "from",
      header: "From",
      wrap: true,
      render: (l) => stopName(dir, l.fromStopId),
    },
    { key: "to", header: "To", wrap: true, render: (l) => stopName(dir, l.toStopId) },
    {
      key: "kind",
      header: "Road",
      title: "OSM carriageway at the To stop (urban · single · dual)",
      render: (l) => kindBadge(legCarriagewayKind(dir, l)),
    },
    {
      key: "factor",
      header: "Factor",
      title: "Ember >12 m coach speed factor applied to Google static time",
      render: (l) => (isNum(l.coachSpeedFactor) ? `x${num(l.coachSpeedFactor, 2)}` : "–"),
      num: true,
    },
    {
      key: "prop",
      header: "Proposed",
      unit: "min",
      title:
        "Minutes between leaving From and leaving To in the proposed timetable (column 1), including boarding time at From",
      render: (l) => num(l.proposedMin),
      num: true,
    },
    {
      key: "modelled",
      header: "Coach (+ dwell)",
      unit: "min",
      title: `Static x per-leg factor + congestion; boarding at From (${sampleLabel(id, doc.estimatedTemporalWindows, direction)} sample)`,
      render: (l) => {
        const total = legModelledTotalMin(l, id, dwellForLeg(l), doc);
        const car = l.windows?.[id]?.durationMin;
        const coach = coachLegMin(l, id, doc);
        const title =
          isNum(car) && isNum(coach)
            ? `Car ${num(car, 1)} min · coach ${num(coach, 1)} min · boarding ${dwellForLeg(l)}s`
            : undefined;
        return (
          <span title={title}>
            <b>{num(total, 1)}</b>
          </span>
        );
      },
      num: true,
    },
    {
      key: "delta",
      header: "Δ",
      unit: "min",
      title:
        "Proposed minus expected coach time (Δ). Positive = proposed allows more time; negative = model needs more time (orange/red).",
      render: (l) => {
        const d = legDeltaMin(l.proposedMin, l, id, dwellForLeg(l), doc);
        if (!isNum(d)) return "–";
        return <span style={deltaShortfallStyle(-d)}>{signed(d, 1)}</span>;
      },
      num: true,
    },
  ];

  const sampleStat = (id: TrafficSampleId) => {
    const mod = modelledEndToEndServiceSample(dir, id, direction, dwellSec, doc);
    const endToEndDelta = isNum(mod) && isNum(prop) ? mod - prop : null;
    return (
      <Stat
        key={id}
        compact
        className="legs-e2e-stat timetable-audit-stat"
        label={sampleLabel(id, doc.estimatedTemporalWindows, direction)}
        value={duration(mod)}
        sub={
          <>
            {sampleDeparture(doc, id, direction)} · {renderE2eDelta(endToEndDelta)}
          </>
        }
        active={sample === id}
        onClick={() => setSample(id)}
      />
    );
  };

  return (
    <>
      <Feedback
        feedback={
          "A traffic profile is built at locations close to outbound and return origin of the proposed route. This is used so end-to-end allowance of the proposed timetable can be stress-tested against free-flow scenerio and each traffic window. The table below breaks the analysis into leg segments. Overall, the schedule looks overoptimistic under realistic coach constraints: long vehicles, road-type speed limits, and mandatory limiters cap achievable speeds below what a flat car-based allowance implies. Every leg is under-scheduled relative to modelled coach time, with the worst gaps on single-carriageway links. The proposed single flat timetable ignores the distinct traffic windows the corridor shows."
        }
        improvements={[
          "Factor speed-limitations imposed on vehicle: Recalibrate the timetable around rules imposed on the vehicle type assigned for the route (which is over 12m), and road type speed limits.",
          "Build timetable per traffic window: Shift away from a single flat timetable and propose distinct schedules tailored to identified WebTRIS traffic windows",
          "Variable dwells: Consider applying variable dwell times with longer dwell at key hubs and shorter dwell at rural stops rather than a flat per-stop dwell across the board.",
        ]}
        considerations={
          [
            {
              label: "Launch period",
              text: "Use the actual route application date to build season-aligned traffic windows instead of today's estimated launch date buffer",
            },
            {
              label: "Traffic data window",
              text: "Expand traffic data window from current 3-year span to improve accuracy.",
            },
            {
              label: "Traffic window sensitivity",
              text: "Traffic windows are detected from local maxima on the traffic profile, with band edges at 80% of peak height today. Tune detection sensitivity to improve accuracy.",
            },
            {
              label: "Scottish vehicle counts",
              text: "Use Transport Scotland NTDS counts data for the A1 north of the border rather than proxying English WebTRIS on the whole corridor.",
            },
            {
              label: "Bank holidays",
              text: "Pull historic traffic patterns for major holidays, if traffic profile is meaningfully different, treat those days as specific dates with their own schedule.",
            },
            {
              label: "Bus lanes",
              text: "Bus-lane detection along route and use adjusted free-flow time where the coach beats car traffic.",
            },
          ] satisfies ConsiderationItem[]
        }
      />
      <Panel
        title="Running times"
        sub="per route segment analysis by traffic window, road type & coach speed limit"
        headerAction={
          <Seg
            value={dayType}
            onChange={setDayType}
            options={[
              { value: "weekday", label: "Weekday", swatch: "var(--weekday)" },
              { value: "weekend", label: "Weekend", swatch: "var(--weekend)" },
            ]}
          />
        }
        tight
      >
        {showTrafficWindows && (
          <>
            <TrafficWindowsPanel doc={doc} direction={direction} dayType={dayType} />
            <hr className="panel-divider" />
          </>
        )}
        {legs.length > 0 ? (
          <>
            <div className="legs-sample-bar">
              <div className="legs-dwell-control">
                <span className="small muted legs-dwell-label">
                  Adjust est. dwell time per stop
                </span>
                <Seg
                  value={String(dwellSec)}
                  options={dwellOptions.map((v) => ({
                    value: String(v),
                    label: v === 0 ? "0s" : `${v}s`,
                  }))}
                  onChange={(v) => setDwellSec(Number(v))}
                />
              </div>
              <div className="legs-e2e-cards">
                <Stat
                  compact
                  className="legs-e2e-stat legs-e2e-ref"
                  label="Proposed timetable"
                  value={duration(prop)}
                  sub="Daily 07:00 start"
                />
                <Stat
                  compact
                  className="legs-e2e-stat legs-e2e-ref"
                  label="Free-flow baseline"
                  value={duration(freeFlow)}
                  sub={
                    isNum(freeFlowDelta) ? (
                      <>0 traffic + dwell · {renderE2eDelta(freeFlowDelta)}</>
                    ) : (
                      "0 traffic + dwell"
                    )
                  }
                />
                {activeSamples.map((id) => sampleStat(id))}
              </div>
            </div>
            <DataTable
              rows={legs}
              columns={columnsFor(sample)}
              rowKey={(l) => `${sample}-${l.fromStopId}-${l.toStopId}`}
            />
          </>
        ) : (
          <Empty>
            No running-time data yet for this direction — Google Routes timing has not
            been computed for this scenario.
          </Empty>
        )}
      </Panel>
    </>
  );
}
