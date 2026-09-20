/** @format */

import { useMemo, useState, type ReactNode } from "react";
import type { ViewProps } from "../App";
import type { Stop } from "../types";
import {
  DataTable,
  Feedback,
  Panel,
  Stat,
  type Column,
  type ConsiderationItem,
} from "../components/ui";
import RouteMap from "../components/RouteMap";
import { depotStop, passengerStops, totalCatchment, totalPoi } from "../lib/derive";
import { KMZ_ALIGN_M, copyText, formatLatLng, matchPins, nearestPin } from "../lib/geo";
import { isNum, num } from "../lib/format";

/** Catchment population and combined POI at or below this are flagged as low-yield. */
const LOW_YIELD_MAX = 99;

function isLowYield(v: number | undefined | null): boolean {
  return isNum(v) && v <= LOW_YIELD_MAX;
}

function combinedPoi(s: Stop): number | null {
  if (!s.poi) return null;
  return (s.poi.weekday ?? 0) + (s.poi.weekend ?? 0);
}

function isLowYieldStop(s: Stop): boolean {
  return isLowYield(s.catchment?.population) && isLowYield(combinedPoi(s));
}

function warnIfLowYieldStop(s: Stop, content: ReactNode) {
  if (!isLowYieldStop(s)) return content;
  return (
    <span style={{ color: "var(--warn)", fontWeight: 600 }} title="Low yield">
      {content}
    </span>
  );
}

export default function RouteStops({ doc, pins, direction }: ViewProps) {
  const dir = doc.directions[direction];
  const stops = passengerStops(dir);
  const catchment = totalCatchment(dir);
  const poi = totalPoi(dir);
  const [selected, setSelected] = useState<string | undefined>();
  const [copiedId, setCopiedId] = useState<string | undefined>();
  const [showPins, setShowPins] = useState(true);

  /** KMZ placemarks paired with engine stops; offsets beyond KMZ_ALIGN_M feed the panel header. */
  const pinInfo = useMemo(() => {
    const byStop = new Map<string, { name: string; metres: number }>();
    for (const s of stops) {
      const n = nearestPin(s, pins, direction);
      if (n) byStop.set(s.naptanId, { name: n.pin.name, metres: n.metres });
    }
    const matches = matchPins(pins, stops, direction);
    const flagged = matches.filter((m) => !m.stop || m.metres > KMZ_ALIGN_M).length;
    return { byStop, total: matches.length, flagged };
  }, [pins, stops, direction]);
  const depot = depotStop(dir);

  const kmzNameCell = (s: Stop) => {
    const p = pinInfo.byStop.get(s.naptanId);
    return p ? p.name : <span className="muted">–</span>;
  };

  const columns: Column<Stop>[] = [
    {
      key: "seq",
      header: "#",
      rowNum: true,
      title: "Passenger stops numbered 1…n in route order",
      render: (_s, i) => String(i + 1),
      num: true,
    },

    {
      key: "kmz",
      header: "KMZ pin",
      title: "KMZ placemark for this direction.",
      render: kmzNameCell,
    },
    {
      key: "name",
      header: "NaPTAN pin",
      render: (s) => {
        const coords = formatLatLng(s.coordinates);
        const copied = copiedId === s.naptanId;
        return (
          <span className="stop-name-cell">
            <a
              href="#"
              title="Focus on map"
              onClick={(e) => {
                e.preventDefault();
                setSelected(s.naptanId);
              }}
              style={{
                color: "inherit",
                textDecoration: s.naptanId === selected ? "underline" : "none",
              }}
            >
              {s.stopName}
            </a>
            <button
              type="button"
              className="copy-coords-btn"
              title={copied ? "Copied" : `Copy ${coords}`}
              aria-label={`Copy coordinates ${coords}`}
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (await copyText(coords)) {
                  setCopiedId(s.naptanId);
                  window.setTimeout(
                    () => setCopiedId((id) => (id === s.naptanId ? undefined : id)),
                    1500,
                  );
                }
              }}
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M20 6 9 17l-5-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
                  <rect
                    x="9"
                    y="9"
                    width="13"
                    height="13"
                    rx="2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                </svg>
              )}
            </button>
          </span>
        );
      },
    },

    { key: "atco", header: "ATCO", render: (s) => <code>{s.naptanId}</code> },
    {
      key: "dev",
      header: "Deviation",
      unit: "min",
      title:
        "Extra coach free-flow minutes to call here vs skipping it (static × per-leg factor + dwell; congestion excluded)",
      render: (s) =>
        isNum(s.deviationMinutes) ? (
          <span
            style={
              s.deviationMinutes >= 8
                ? { color: "var(--warn)", fontWeight: 600 }
                : undefined
            }
          >
            {num(s.deviationMinutes, 1)}
          </span>
        ) : (
          "–"
        ),
      num: true,
    },
    {
      key: "pop",
      header: "10-min walk catchment",
      title:
        "Residents within a 10-minute walk; flagged when both catchment and combined POI are ≤99",
      render: (s) => warnIfLowYieldStop(s, num(s.catchment?.population)),
      num: true,
    },
    {
      key: "poi",
      header: "POI wkday / wkend",
      title:
        "Combined weekday + weekend POI gravity; flagged when both catchment and combined POI are ≤99",
      render: (s) => {
        if (!s.poi) return "–";
        return warnIfLowYieldStop(s, `${num(s.poi.weekday)} / ${num(s.poi.weekend)}`);
      },
      num: true,
    },
  ];

  return (
    <>
      <Feedback
        feedback="Every proposed stop matches an official NaPTAN record ≤ 5m and the overall stop set is mostly reasonable, but there are pin placement errors, clustered town stops, and low-yield deviations that should be addressed. Use the map and stops table below to review specifics. Deviation ≥8 min and low-yield stops are flagged in amber in the stops table."
        improvements={[
          "Fix pin positioning at Houndwood first: Outbound/return pins appear to be on the wrong side of the carriageway, inflating deviation to 21-minutes. Swapping the directional stops reduces this significantly; however, given its 3-person walk catchment and zero POI gravity, investigate if keeping this stop on the route is justified or if there are better nearby alternatives.",
          "Keep Haddington despite high deviation: Although it incurs the second-costliest deviation, keep the stop as it captures 4,500+ residents within a 10-minute walk and carries strong POI gravity. Investigate whether there exists alternative stop closer to the main A1 junction that allows us to preserve this high-yielding market while trimming off-route driving time.",
          "Review rural low-yield stops in order of priority: Investigate Tritlington, North Charlton, Belford, Haggerston, Burnmout and Houndwood for nearby NaPTAN alternatives. They are cheap on deviation (≤5 min), but serve ≤25 walk-catchment residents each, so pre-booked demand is likely minimal. Look for alternative towns directly along the A1 corridor that offer higher catchment populations and stronger POI gravity.",
          "Optimize stop spacing in Morpeth: There is a slight overlap between the Morpeth Loansdean and Morpeth Town Centre catchments on the outbound route. Rather than dropping coverage, consider shifting Loansdean further south and/or Town Centre further north, depending on catchment population and POI score movement, to better space out the stops. Make sure to see how alternative stops affect the return route as well. You could also consider consolidating to Morpeth Town Centre (2,903 catchment) if protecting through-journey speeds to Edinburgh is the primary goal.",
        ]}
        considerations={
          [
            {
              label: "Driving catchments",
              text: "Beyond walking catchments, factoring in driving catchments and nearby car parking helps asses park-and-ride potential at strategic A1 stops.",
            },
            {
              label: "Population distribution",
              text: "Model assumes uniform density when calculating population in catchment. Weighting residential land use near each stop would improve population estimates.",
            },
            {
              label: "School terms",
              text: "Primary and secondary schools are not counted as POI landmarks today (only university/college). Factoring in term-time student travel would improve POI estimates.",
            },
            {
              label: "Nearby interchanges",
              text: "Check for established competitor hubs or transport interchanges near proposed stops as being nearer to them makes the route more attractive to connecting passengers.",
            },
            {
              label: "Route benchmarks",
              text: "The route's combined walk catchment population and POI score are hard to judge on their own, benchmark both against other performing Ember routes rather than reading the figures in isolation.",
            },
          ] satisfies ConsiderationItem[]
        }
      />
      <Panel title={`Route & stops`}>
        <div className="stats margin-bottom-12">
          <Stat
            compact
            label={`Passenger stops`}
            value={stops.length}
            sub={`Matched to closest NaPTAN`}
          />

          <Stat
            compact
            label={`Likely reachable population`}
            value={num(catchment)}
            sub="Σ residents within 10-min walk of each stop"
          />
          <Stat
            compact
            label={`Trip attractors`}
            dayType="weekday"
            value={isNum(poi.weekday) ? `${num(poi.weekday)}` : "–"}
            sub="Σ POI gravity within 10-min walk of each stop"
          />
          <Stat
            compact
            label={`Trip attractors`}
            dayType="weekend"
            value={isNum(poi.weekend) ? `${num(poi.weekend)}` : "–"}
            sub="Σ POI gravity within 10-min walk of each stop"
          />
        </div>
        <RouteMap
          doc={doc}
          direction={direction}
          pins={pins}
          showPins={showPins}
          selected={selected}
          onSelect={(s) => setSelected(s.naptanId)}
        />
        <div className="legend" style={{ marginTop: 8 }}>
          {depot && (
            <span>
              <i className="swatch" style={{ background: "#0c0b0a" }} />
              Depot
            </span>
          )}
          <span>
            <i className="swatch" style={{ background: "var(--outbound)" }} />
            Outbound stop
          </span>
          <span>
            <i className="swatch" style={{ background: "var(--return)" }} />
            Return stop
          </span>
          <span>
            <i
              className="swatch"
              style={{
                background: "var(--catchment-fill)",
                border: "1px solid var(--catchment-line)",
              }}
            />
            10-min walk catchment
          </span>

          {pins.length > 0 && (
            <>
              <span>
                <i
                  className="swatch"
                  style={{
                    background: "#AECFE2",
                    border: "2px solid #0c0b0a",
                    transform: "rotate(45deg)",
                    width: 10,
                    height: 10,
                  }}
                />
                Pin from KMZ layer
              </span>
              <label style={{ marginLeft: "auto" }}>
                <input
                  type="checkbox"
                  checked={showPins}
                  onChange={(e) => setShowPins(e.target.checked)}
                />{" "}
                Show KMZ layer pins
              </label>
            </>
          )}
        </div>
      </Panel>
      <Panel title="Stops table">
        <DataTable
          rows={stops}
          columns={columns}
          rowKey={(s) => `${direction}-${s.naptanId}-${s.sequenceOrder}`}
        />
      </Panel>
    </>
  );
}
