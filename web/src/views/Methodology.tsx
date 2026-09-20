/** @format */

import type { ViewProps } from "../App";
import type { Assumption, EngineDocument } from "../types";
import { Panel } from "../components/ui";
import {
  assumptionRow,
  bandPeriodLabel,
  serviceTemporalWindows,
  trafficSamplePeriodLabel,
} from "../lib/derive";
import { num } from "../lib/format";

interface MethodBullet {
  text: string;
  sources?: string[];
}

interface MethodologySection {
  title: string;
  method: MethodBullet[];
}

interface MethodologyRow {
  id: string;
  text: string;
  sources?: string[];
}

function assumptionRange(a: Assumption | undefined): string {
  if (!a || (a.low == null && a.high == null)) return "";
  const unit = a.unit ? ` ${a.unit}` : "";
  return ` (${a.low ?? "–"} – ${a.high ?? "–"}${unit})`;
}

function buildMethodologySections(doc: EngineDocument): MethodologySection[] {
  const dwell = assumptionRow(doc, "dwellTimeBufferSeconds");
  const coach = assumptionRow(doc, "coachTimeFactor");
  const detour = assumptionRow(doc, "pathDetourWarnRatio");
  const gap = assumptionRow(doc, "headwayGapThresholdMinutes");
  const walk = assumptionRow(doc, "isochroneWalkSeconds");
  const consumption = assumptionRow(doc, "consumptionKwhPerKm");
  const drivers = assumptionRow(doc, "driversHours");

  const tp = doc.trafficProfile;
  const w = doc.estimatedTemporalWindows;
  const f = doc.fleet;
  const walkMin = walk?.value ?? 10;

  const temporalDetail = (() => {
    if (!w) return "";
    const out = serviceTemporalWindows(w, "outbound");
    const ret = serviceTemporalWindows(w, "return");
    const bands = (dir: typeof out) =>
      (dir?.weekdayBands ?? [])
        .map((b) => `${bandPeriodLabel(b)} (apex ${b.apex})`)
        .join("; ");
    const outS = bands(out);
    const retS = bands(ret);
    if (!outS && !retS) return "";
    return ` This run: outbound ${outS || "–"}; return ${retS || "–"}.`;
  })();

  const trafficPeriod = tp?.period
    ? ` Sample period ${trafficSamplePeriodLabel(tp.period)}.`
    : "";

  const corridorCoverage =
    tp?.coverage?.corridorKmWithSites != null && tp?.coverage?.corridorKmTotal != null
      ? ` ${num(tp.coverage.corridorKmWithSites)} of ${num(tp.coverage.corridorKmTotal)} km of the corridor has a count site within range.`
      : "";

  const coachFallback =
    coach?.value != null
      ? ` Fallback when a leg is untagged: x${num(coach.value, 2)}${assumptionRange(coach)}.`
      : "";

  const consumptionDetail = consumption
    ? ` ${num(consumption.low ?? 1, 2)} / ${num(consumption.value, 2)} / ${num(consumption.high ?? 1.5, 2)} kWh/km scenarios${assumptionRange(consumption)}`
    : " low / central / high consumption scenarios";

  const batteryKwh =
    f?.parameters?.vehicle?.batteryKwh ??
    (f?.energy?.central?.usableKwh != null && f?.energy?.central?.socFloor != null
      ? f.energy.central.usableKwh / (1 - f.energy.central.socFloor)
      : undefined);

  const rechargeDetail = (() => {
    const parts: string[] = [];
    if (batteryKwh != null) {
      parts.push(
        `${num(batteryKwh)} kWh pack${f?.parameters?.vehicle?.socFloor != null ? `, ${num(f.parameters.vehicle.socFloor * 100, 0)}% reserve floor` : ""}`,
      );
    }
    if (f?.charging) {
      for (const [c, ch] of Object.entries(f.charging)) {
        parts.push(
          `${c} cable${c === "1" ? "" : "s"}: ${num(ch.powerKw)} kW, ${num(ch.minutes)} min full recharge`,
        );
      }
    }
    return parts.length ? ` ${parts.join("; ")}.` : "";
  })();

  const deadKm =
    f?.distance?.deadKm != null
      ? ` Depot runs total ${num(f.distance.deadKm, 1)} km per return trip (both legs).`
      : "";

  const driversValue =
    drivers?.value ??
    "≤ 4 h 30 continuous driving, ≥ 45 min break, ≤ 9 h daily driving; continuous working ≤ 6 h (RT(WT)R 2005)";

  return [
    {
      title: "Route",
      method: [
        {
          text: "Stops validation — KMZ pins are matched to the nearest official stop with pairings >5m apart flagged.",
          sources: ["KMZ pins", "NaPTAN"],
        },
        {
          text: "Deviation minutes — coach free-flow extra time to call at the stop vs skipping it (static × per-leg carriageway factor, congestion excluded) plus dwell.",
          sources: ["Google Routes", "OSM"],
        },
        {
          text: `Walk catchment — population within a ${walkMin}-minute walk isochrone, apportioned by census zone overlap.${walk?.note ? ` ${walk.note}` : ""}`,
          sources: [
            "OpenRouteService",
            "ONS LSOA 2021",
            "Census 2021 TS001",
            "ScotGov Data Zone 2022",
          ],
        },
        {
          text: "POI gravity — infrastructure score within each stop's 10-minute walk catchment.",
          sources: ["OpenStreetMap Overpass API"],
        },
        {
          text: "Competitor coverage — a BODS/TNDS journey counts when it calls both stops of a directional OD pair on our route.",
          sources: ["BODS", "TNDS Scotland"],
        },
        {
          text: `Distance detour ratio — coach path distance vs direct car distance; pairs flagged when the ratio exceeds ${detour?.value ?? 1.25}×.`,
          sources: ["Google Routes", "Route Matrix"],
        },
        {
          text: "Time detour ratio — in-vehicle time of the service route (static × per-leg carriageway factor + dwell) vs driving direct.",
          sources: ["Google Routes", "Route Matrix", "OSM"],
        },
      ],
    },
    {
      title: "Timetable",
      method: [
        {
          text: `Traffic windows — for each of the past three years, three months of WebTRIS counter volumes season-aligned to estimated launch (today + 70 days); bank holidays excluded; normalised to % of daily flow; weekday and weekend averaged separately; peak bands detected from how traffic shape differs by time of day and day type, so running times and departure samples reflect realistic congestion patterns.${trafficPeriod}${temporalDetail}`,
          sources: ["WebTRIS"],
        },
        {
          text: `Counter selection — outbound uses the nearest qualifying northbound site to Newcastle; return uses the nearest qualifying southbound site to Edinburgh; Scottish A1 proxied by the closest English southbound counter (WebTRIS is England-only).${corridorCoverage}`,
          sources: ["WebTRIS"],
        },
        {
          text: `Peak candidate slots — ≥${gap?.value ?? 60}-min window between competitor departures overlapping a WebTRIS peak band; a candidate time to place a trip.${gap?.note ? ` ${gap.note}` : ""}`,
          sources: ["WebTRIS", "BODS"],
        },
        {
          text: "Service time judgement — prefer columns with more Out/Ret gap hits on weekday and Saturday BODS separately; compare clock times to candidate slot windows on key overlapping pairs.",
          sources: ["Proposed Timetable", "BODS"],
        },
        {
          text: "Segment achievability — for each stop-to-stop leg, Google Routes returns traffic-aware drive time at weekday and weekend peak windows; compared against minutes allowed in the proposed timetable.",
          sources: ["Google Routes", "WebTRIS", "OSM", "KMZ"],
        },
        {
          text: `Coach time scaling — Google car static × per-leg OSM carriageway factor (urban x1.0, single x1.2, dual x1.17 for coaches >12 m) plus congestion delay; ${dwell?.value ?? 75} s boarding time per intermediate stop.${coachFallback}${coach?.note ? ` ${coach.note}` : ""}`,
          sources: ["Google Routes", "OSM"],
        },
      ],
    },
    {
      title: "Fleet",
      method: [
        {
          text: `Round-trip energy —${consumptionDetail} Tests whether one outbound + return fits within pack capacity.`,
          sources: ["Google Routes", "Config"],
        },
        {
          text: `Recharge time — full pack from reserve floor to 100% SoC; flat cable power plus plug-handling allowance.${rechargeDetail}`,
          sources: ["Config"],
        },
        {
          text: "Vehicle count — greedy block scheduler assigns timetable columns to vehicles; first unassignable column drops the rest.",
          sources: ["Proposed Timetable", "Config"],
        },
        {
          text: `Drivers' shift check — ${driversValue}; one driver per column; depot runs count as driving time.${deadKm}`,
          sources: [
            drivers?.source ?? "Assimilated EU Regulation 561/2006",
            "Road Transport (Working Time) Regulations 2005",
          ],
        },
      ],
    },
  ];
}

function parseMethodBullet(item: MethodBullet): MethodologyRow {
  const sep = " — ";
  const i = item.text.indexOf(sep);
  if (i === -1) return { id: "Note", text: item.text, sources: item.sources };
  return {
    id: item.text.slice(0, i),
    text: item.text.slice(i + sep.length),
    sources: item.sources,
  };
}

function MethodologyRows({ items }: { items: MethodologyRow[] }) {
  if (!items.length) return null;
  return (
    <ul className="small methodology-list">
      {items.map((item) => (
        <li key={`${item.id}-${item.text}`}>
          <span className="methodology-id">{item.id}</span> {item.text}
          {item.sources && item.sources.length > 0 && (
            <span className="consideration-sources">
              {item.sources.map((s) => (
                <span key={s} className="source-tag">
                  {s}
                </span>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function Methodology({ doc }: ViewProps) {
  const sections = buildMethodologySections(doc);

  return (
    <>
      {sections.map((section) => (
        <Panel key={section.title} title={section.title} tight>
          <MethodologyRows items={section.method.map(parseMethodBullet)} />
        </Panel>
      ))}
    </>
  );
}
