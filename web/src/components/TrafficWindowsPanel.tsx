/** @format */

import { useState, type ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DirectionName, EngineDocument } from "../types";
import type { TrafficBand, TrafficBasisSite } from "../types";
import TrafficCountersMap from "./TrafficCountersMap";
import { bandLabel } from "../lib/derive";
import { num, parseHHMM } from "../lib/format";

const HOUR_TICKS = Array.from({ length: 24 }, (_, h) => h * 60);
/** Recharts legend — the series is normalised WebTRIS volume share, not raw counts. */
const TRAFFIC_SHARE_SERIES = "Share of daily traffic (%)";

/** 96 x 15-minute points — same granularity as detectBands. Falls back to hourly ÷ 4 for old scenarios. */
function quarterSeries(quarter?: number[], hourly?: number[]) {
  if (quarter?.length === 96) {
    return quarter.map((flow, i) => ({ t: i * 15, flow: flow ?? null }));
  }
  return HOUR_TICKS.flatMap((h) =>
    [0, 15, 30, 45].map((m) => ({
      t: h + m,
      flow: hourly?.[h / 60] != null ? hourly[h / 60]! / 4 : null,
    })),
  );
}

function clockTick(m: number) {
  const h = Math.floor(m / 60),
    mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

const WEEKDAY_COLOR = "var(--weekday)";
const WEEKEND_COLOR = "var(--weekend)";

function TrafficBands({
  bands,
  peakColor = WEEKDAY_COLOR,
}: {
  bands?: TrafficBand[];
  peakColor?: string;
}) {
  if (!bands?.length) return null;
  return (
    <>
      {bands.map((b) => {
        const start = parseHHMM(b.start);
        const end = parseHHMM(b.end);
        if (start == null || end == null) return null;
        const fill = b.kind === "peak" ? peakColor : "var(--muted-bg)";
        const opacity = b.kind === "peak" ? 0.1 : 0.5;
        const labelColor = b.kind === "peak" ? peakColor : "var(--muted)";
        return (
          <ReferenceArea
            key={b.id}
            x1={start}
            x2={end}
            fill={fill}
            fillOpacity={opacity}
            label={{
              value: bandLabel(b),
              position: "insideBottom",
              fontSize: 10,
              fill: labelColor,
              dy: -14,
            }}
          />
        );
      })}
    </>
  );
}

function ApexMarker({
  band,
  peakColor = WEEKDAY_COLOR,
}: {
  band: TrafficBand;
  peakColor?: string;
}) {
  const t = parseHHMM(band.apex);
  if (t == null) return null;
  const color = band.kind === "peak" ? peakColor : "var(--muted)";
  return (
    <ReferenceLine
      x={t}
      stroke={color}
      strokeWidth={1.5}
      strokeDasharray="4 3"
      label={{
        value: `${bandLabel(band)} apex`,
        position: "top",
        offset: 6,
        fontSize: 10,
        fill: color,
      }}
    />
  );
}

function TrafficChart({
  data,
  dataKey,
  name,
  stroke,
  children,
}: {
  data: ReturnType<typeof quarterSeries>;
  dataKey: string;
  name: string;
  stroke: string;
  children?: ReactNode;
}) {
  return (
    <div className="peak-windows-chart">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 22, right: 36, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
          <XAxis
            type="number"
            dataKey="t"
            domain={[0, 24 * 60 - 1]}
            ticks={HOUR_TICKS.filter((_, i) => i % 2 === 0)}
            tickFormatter={clockTick}
            tick={{ fontSize: 11 }}
          />
          <YAxis tick={{ fontSize: 11 }} unit="%" width={48} />
          <Tooltip
            labelFormatter={(label) =>
              typeof label === "number" ? clockTick(label) : String(label ?? "")
            }
            formatter={(v) => (typeof v === "number" ? `${num(v, 2)}% / 15 min` : "–")}
          />
          {/* <Legend /> */}
          {children}
          <Line
            type="natural"
            dataKey={dataKey}
            name={name}
            stroke={stroke}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function counterSummary(
  site: TrafficBasisSite | undefined,
  direction: DirectionName,
): { label: string; value: string; sub: string } {
  const label = `${direction === "outbound" ? "Outbound" : "Return"} vehicle counter`;
  if (!site) {
    return { label, value: "–", sub: "No counter assigned for this direction" };
  }
  return {
    label,
    value: String(site.id),
    sub: site.anchorStopName
      ? `from ${site.anchorStopName}`
      : site.name || "WebTRIS vehicle counter",
  };
}

export function hasTrafficWindowsData(
  doc: EngineDocument,
  direction: DirectionName,
): boolean {
  const tp = doc.trafficProfile;
  const basis = tp?.basisSites?.find((s) => s.serviceDirection === direction);
  return Boolean(tp || (basis?.weekdayBands ?? []).length);
}

export default function TrafficWindowsPanel({
  doc,
  direction,
  dayType,
}: {
  doc: EngineDocument;
  direction: DirectionName;
  dayType?: "weekday" | "weekend";
}) {
  const [mapExpanded, setMapExpanded] = useState(false);
  const tp = doc.trafficProfile;
  const basis = tp?.basisSites?.find((s) => s.serviceDirection === direction);
  const weekdaySeries = quarterSeries(
    basis?.weekdayQuarterHourPct,
    basis?.weekdayHourlyPct,
  );
  const weekendSeries = quarterSeries(
    basis?.weekendQuarterHourPct,
    basis?.weekendHourlyPct,
  );
  const bands = basis?.weekdayBands ?? [];
  const weekendBand = doc.estimatedTemporalWindows?.[direction]?.weekendPeakBand;
  const hasRouteMap = Boolean(doc.directions[direction]?.routePolyline);
  const showMapPreview = hasRouteMap && Boolean(tp?.basisSites?.length);
  const counter = counterSummary(basis, direction);

  if (!hasTrafficWindowsData(doc, direction)) return null;

  const showWeekday = dayType == null || dayType === "weekday";
  const showWeekend = dayType == null || dayType === "weekend";

  return (
    <>
      <div className={`peak-windows-layout${dayType ? " peak-windows-single-day" : ""}`}>
        {showWeekday && (
          <div className="peak-windows-chart-panel peak-windows-weekday">
            <p
              className="small muted peak-windows-chart-label"
              style={{ fontWeight: "bold", color: WEEKDAY_COLOR }}
            >
              Weekday Traffic Profile
            </p>
            <TrafficChart
              data={weekdaySeries}
              dataKey="flow"
              name={TRAFFIC_SHARE_SERIES}
              stroke={WEEKDAY_COLOR}
            >
              <TrafficBands bands={bands} />
              {bands
                .filter((b) => b.kind === "peak")
                .map((b) => (
                  <ApexMarker key={b.id} band={b} />
                ))}
            </TrafficChart>
          </div>
        )}
        {showWeekend && (
          <div className="peak-windows-chart-panel peak-windows-weekend">
            <p
              className="small muted peak-windows-chart-label"
              style={{ fontWeight: "bold", color: WEEKEND_COLOR }}
            >
              Weekend Traffic Profile
            </p>
            <TrafficChart
              data={weekendSeries}
              dataKey="flow"
              name={TRAFFIC_SHARE_SERIES}
              stroke={WEEKEND_COLOR}
            >
              <TrafficBands
                bands={weekendBand ? [weekendBand] : undefined}
                peakColor={WEEKEND_COLOR}
              />
              {weekendBand && <ApexMarker band={weekendBand} peakColor={WEEKEND_COLOR} />}
            </TrafficChart>
          </div>
        )}
        <div
          className={`peak-windows-map-panel${showMapPreview ? " clickable" : ""}`}
          onClick={showMapPreview ? () => setMapExpanded(true) : undefined}
          role={showMapPreview ? "button" : undefined}
          tabIndex={showMapPreview ? 0 : undefined}
          onKeyDown={
            showMapPreview
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setMapExpanded(true);
                  }
                }
              : undefined
          }
        >
          {showMapPreview && tp?.basisSites ? (
            <TrafficCountersMap
              doc={doc}
              sites={tp.basisSites}
              direction={direction}
              embed
              frameMode="corridor"
              showLegend={false}
            />
          ) : (
            <p className="small muted peak-windows-map-hint">
              Route polyline not in this scenario — re-run the engine to generate the map.
            </p>
          )}
          <p className="small muted peak-windows-chart-label">{counter.label}</p>
        </div>
      </div>

      {mapExpanded && showMapPreview && tp?.basisSites && (
        <div
          className="map-expand-overlay"
          role="presentation"
          onClick={() => setMapExpanded(false)}
        >
          <div
            className="map-expand-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Vehicle counter map"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="map-expand-header">
              <strong>
                {counter.label} {counter.value} {counter.sub}
              </strong>
              <button
                type="button"
                className="map-expand-close"
                onClick={() => setMapExpanded(false)}
              >
                Close
              </button>
            </div>
            <TrafficCountersMap doc={doc} sites={tp.basisSites} direction={direction} />
          </div>
        </div>
      )}
    </>
  );
}
