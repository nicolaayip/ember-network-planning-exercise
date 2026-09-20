/** @format */

import { useMemo, useState } from "react";
import type { ViewProps } from "../App";
import type { Fleet, FleetScenario, FleetVehicleParams, ScenarioName } from "../types";
import {
  Badge,
  DataTable,
  Empty,
  Feedback,
  Panel,
  Seg,
  Stat,
  type ConsiderationItem,
} from "../components/ui";
import DriversShiftCheck from "../components/DriversShiftCheck";
import { SCENARIOS } from "../lib/derive";
import { scheduleFleetScenario } from "../lib/fleet-schedule";
import { clock, duration, isNum, num, pct } from "../lib/format";

type CableTab = "1" | "2";

type EnergyTableRow = {
  s: string;
  kwhPerKm?: number;
  energyKwh?: number;
  packUsePct?: number;
  socOnReturn?: number;
  feasible?: boolean;
};

const EXCEEDS_PACK = "one return exceeds full pack capacity";

const GANTT_TOP = 22;
const GANTT_ROW_H = 30;
const GANTT_CABLE_BAND = 40;
const GANTT_LEGEND_H = 36;

function ganttSvgHeight(fixedRows: number) {
  return GANTT_TOP + fixedRows * GANTT_ROW_H + GANTT_CABLE_BAND;
}

function ganttPanelHeight(fixedRows: number) {
  return ganttSvgHeight(fixedRows) + GANTT_LEGEND_H;
}

function groupUnassigned(unassigned: NonNullable<FleetScenario["unassignedColumns"]>) {
  const groups = new Map<string, string[]>();
  for (const u of unassigned) {
    const key = u.reason ?? "Could not schedule";
    const ids = groups.get(key);
    if (ids) ids.push(u.columnId);
    else groups.set(key, [u.columnId]);
  }
  return groups;
}

function isExceedsPackNotice(
  unassigned: NonNullable<FleetScenario["unassignedColumns"]>,
  tripEnergyKwh?: number,
  batteryKwh?: number,
) {
  const groups = groupUnassigned(unassigned);
  const entries = [...groups.entries()];
  return (
    entries.length === 1 &&
    entries[0][0] === EXCEEDS_PACK &&
    entries[0][1].length === unassigned.length &&
    isNum(tripEnergyKwh) &&
    isNum(batteryKwh)
  );
}

function unassignedBadge(
  unassigned: NonNullable<FleetScenario["unassignedColumns"]>,
): string {
  if (unassigned.length === 1) return `${unassigned[0].columnId} unassigned`;
  return `${unassigned.length} columns unassigned`;
}

function UnassignedNotice({
  unassigned,
  tripEnergyKwh,
  batteryKwh,
}: {
  unassigned: NonNullable<FleetScenario["unassignedColumns"]>;
  tripEnergyKwh?: number;
  batteryKwh?: number;
}) {
  const groups = groupUnassigned(unassigned);
  const entries = [...groups.entries()];

  if (
    isExceedsPackNotice(unassigned, tripEnergyKwh, batteryKwh) &&
    isNum(tripEnergyKwh) &&
    isNum(batteryKwh)
  ) {
    return (
      <p className="small muted fleet-unassigned-notice">
        One outbound + return trip needs <strong>{num(tripEnergyKwh)} kWh</strong> (
        {num((tripEnergyKwh / batteryKwh) * 100, 1)}% of the {num(batteryKwh)} kWh pack).
        No columns can run at this consumption rate.
      </p>
    );
  }

  if (entries.length === 1 && entries[0][1].length === unassigned.length) {
    return (
      <p className="small muted fleet-unassigned-notice">
        All {entries[0][1].length} columns — {entries[0][0]}
      </p>
    );
  }

  return (
    <div className="small muted fleet-unassigned-notice">
      <ul className="fleet-unassigned-list">
        {entries.map(([reason, ids]) => (
          <li key={reason}>
            <strong>{ids.join(", ")}</strong> — {reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gantt({ sc, fixedRows }: { sc: FleetScenario; fixedRows: number }) {
  const vehicles = sc.vehicles ?? [];
  const grid = sc.grid;
  const panelH = ganttPanelHeight(fixedRows);
  if (!grid) {
    return (
      <div className="gantt gantt-fixed" style={{ minHeight: panelH }}>
        <Empty>No scenario data.</Empty>
      </div>
    );
  }
  const t0 = grid.dayStart,
    t1 = grid.dayEnd;
  const W = 1150,
    L = 110,
    R = 10,
    top = GANTT_TOP,
    rowH = GANTT_ROW_H;
  const cables = sc.cablesPerSlot ?? [];
  const vehicleBand = fixedRows * rowH;
  const cableY = top + vehicleBand;
  const H = ganttSvgHeight(fixedRows);
  const x = (m: number) => L + ((m - t0) / (t1 - t0)) * (W - L - R);
  const hours: number[] = [];
  for (let m = Math.ceil(t0 / 60) * 60; m <= t1; m += 60) hours.push(m);
  const maxCables = Math.max(1, ...cables);
  return (
    <div className="gantt gantt-fixed" style={{ minHeight: panelH }}>
      <svg width={W} height={H}>
        {hours.map((m) => (
          <g key={m}>
            <line x1={x(m)} x2={x(m)} y1={top - 4} y2={H} stroke="var(--line)" />
            <text x={x(m)} y={12} className="lbl" textAnchor="middle">
              {clock(m).replace(" (+1)", "⁺")}
            </text>
          </g>
        ))}
        {!vehicles.length && (
          <text
            x={L + (W - L - R) / 2}
            y={top + vehicleBand / 2}
            className="lbl"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            No vehicles scheduled in this scenario.
          </text>
        )}
        {vehicles.map((v, i) => {
          const y = top + i * rowH;
          return (
            <g key={v.id}>
              <text x={L - 8} y={y + 15} fontSize={11} textAnchor="end" fill="var(--ink)">
                {v.id}
              </text>
              <text x={L - 8} y={y + 26} className="lbl" textAnchor="end">
                {(v.columnIds ?? []).join("+")}
              </text>
              {v.blocks.map((b, j) => {
                const w = Math.max(1, x(b.end) - x(b.start));
                const label =
                  b.type === "trip"
                    ? (b.columnId ?? "trip")
                    : b.type === "charge"
                      ? `charge${b.cables ? ` x${b.cables}` : ""}`
                      : b.type;
                const title = `${label}: ${clock(b.start)} – ${clock(b.end)} (${duration(b.end - b.start)})${isNum(b.socStart) ? ` · SoC ${pct(b.socStart)}${isNum(b.socEnd) ? ` → ${pct(b.socEnd)}` : ""}` : ""}`;
                return (
                  <g key={j}>
                    <rect
                      x={x(b.start)}
                      y={y + 4}
                      width={w}
                      height={b.type === "idle" ? 10 : 20}
                      rx={2}
                      className={`blk-${b.type}`}
                      transform={b.type === "idle" ? `translate(0,5)` : undefined}
                    >
                      <title>{title}</title>
                    </rect>
                    {w > 40 && b.type !== "idle" && (
                      <text x={x(b.start) + 4} y={y + 18} className="blk-text">
                        {label}
                      </text>
                    )}
                  </g>
                );
              })}
              {isNum(v.socEndOfDay) && (
                <text x={W - R} y={y + 15} className="lbl" textAnchor="end">
                  end SoC {pct(v.socEndOfDay)}
                </text>
              )}
            </g>
          );
        })}
        <g>
          <text x={L - 8} y={cableY + 22} className="lbl" textAnchor="end">
            cables in use
          </text>
          {cables.map((n, i) => {
            const s = t0 + i * grid.slotMinutes;
            const h = (n / maxCables) * 24;
            return n > 0 ? (
              <rect
                key={i}
                x={x(s)}
                y={cableY + 30 - h}
                width={Math.max(1, x(s + grid.slotMinutes) - x(s) - 0.5)}
                height={h}
                fill={sc.cablesWithinCapacity === false ? "var(--bad)" : "var(--charge)"}
                opacity={0.7}
              >
                <title>{`${clock(s)}: ${n} cable(s)`}</title>
              </rect>
            ) : null;
          })}
        </g>
      </svg>
      <div className="legend">
        <span>
          <i className="swatch" style={{ background: "var(--trip)" }} />
          Outbound + return trip
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--charge)" }} />
          Charging
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--idle)" }} />
          Idle at depot
        </span>
      </div>
    </div>
  );
}

function returnTripDistanceKm(fleet: Fleet): number | undefined {
  const { returnTripKm, deadKm } = fleet.distance ?? {};
  if (isNum(returnTripKm) && isNum(deadKm)) return returnTripKm + deadKm;
  return fleet.energy?.central?.totalKm;
}

function chargeToFullStat(
  cables: number,
  floor: number,
  charging: Fleet["charging"],
  plugHandlingMin: number,
  headroomKwh?: number,
) {
  const c = charging?.[String(cables)];
  if (!c) return null;
  const plug = isNum(c.plugHandlingMinutes) ? c.plugHandlingMinutes : plugHandlingMin;
  const energyKwh = isNum(headroomKwh) ? headroomKwh : c.energyKwh;
  const chargingMin =
    isNum(energyKwh) && isNum(c.powerKw) && c.powerKw > 0
      ? Math.round((energyKwh / c.powerKw) * 60)
      : (c.chargingMinutes ?? (isNum(c.minutes) ? c.minutes - plug : undefined));
  const totalMin = isNum(chargingMin) ? chargingMin + plug : c.minutes;
  if (!isNum(totalMin)) return null;
  const cableLabel = cables === 1 ? "1 cable" : `${cables} cables`;
  return (
    <Stat
      compact
      label={`${cableLabel} · ${pct(floor)} → 100%`}
      value={duration(totalMin)}
      sub={
        <>
          {isNum(chargingMin) ? `${duration(chargingMin)} charging` : null}
          {isNum(chargingMin) ? " + " : null}
          {plug} min plug handling
        </>
      }
    />
  );
}

function fleetVehicle(fleet: Fleet): FleetVehicleParams {
  const v = fleet.parameters?.vehicle;
  if (v?.batteryKwh) return v;
  const e = fleet.energy?.central;
  const floor = e?.socFloor ?? 0.1;
  if (e?.usableKwh && isNum(e.socStart) && e.socStart > floor) {
    return { batteryKwh: e.usableKwh / (e.socStart - floor), socFloor: floor };
  }
  if (isNum(e?.usableKwh)) {
    return { batteryKwh: e.usableKwh / (1 - floor), socFloor: floor };
  }
  return { socFloor: floor };
}

export default function FleetView({ doc }: ViewProps) {
  const fleet = doc.fleet;
  const [scenario, setScenario] = useState<ScenarioName>("central");
  const [cables, setCables] = useState<CableTab>("2");
  const sc = useMemo(
    () =>
      fleet ? scheduleFleetScenario(doc, fleet, scenario, Number(cables) as 1 | 2) : null,
    [doc, fleet, scenario, cables],
  );
  const maxVehicleRows = useMemo(() => {
    if (!fleet) return 1;
    let max = 0;
    for (const s of SCENARIOS) {
      for (const c of [1, 2] as const) {
        const r = scheduleFleetScenario(doc, fleet, s, c);
        max = Math.max(max, r?.vehicles?.length ?? 0);
      }
    }
    return Math.max(max, 1);
  }, [doc, fleet]);
  if (!fleet)
    return (
      <>
        <Feedback />
        <Empty>No fleet data — the vehicles phase has not run for this scenario.</Empty>
      </>
    );
  const vehicle = fleetVehicle(fleet);
  const floor = vehicle.socFloor ?? fleet.energy?.central?.socFloor ?? 0.1;
  const headroomKwh =
    isNum(vehicle.batteryKwh) && isNum(floor)
      ? Math.round(vehicle.batteryKwh * (1 - floor) * 10) / 10
      : undefined;
  const totalKm = fleet.energy?.central?.totalKm ?? returnTripDistanceKm(fleet);
  const energyRows: EnergyTableRow[] = [
    ...SCENARIOS.map((s) => {
      const row = fleet.energy?.[s] ?? {};
      if (!isNum(headroomKwh) || !isNum(vehicle.batteryKwh)) return { s, ...row };
      const energyKwh = row.energyKwh;
      const socOnReturn = isNum(energyKwh)
        ? 1 - energyKwh / vehicle.batteryKwh
        : row.socOnReturn;
      const packUsePct =
        isNum(energyKwh) && isNum(vehicle.batteryKwh)
          ? (energyKwh / vehicle.batteryKwh) * 100
          : undefined;
      const feasible =
        isNum(socOnReturn) && isNum(floor) ? socOnReturn >= floor : row.feasible;
      return {
        s,
        ...row,
        socStart: 1,
        socOnReturn,
        packUsePct,
        feasible,
      };
    }),
    ...(isNum(fleet.breakEvenKwhPerKm) && isNum(totalKm) && isNum(headroomKwh)
      ? [
          {
            s: "break-even",
            kwhPerKm: fleet.breakEvenKwhPerKm,
            totalKm,
            energyKwh: headroomKwh,
            packUsePct: isNum(vehicle.batteryKwh)
              ? (headroomKwh / vehicle.batteryKwh) * 100
              : 90,
            socOnReturn: floor,
            feasible: true,
          },
        ]
      : []),
  ].sort((a, b) => {
    const ka = isNum(a.kwhPerKm) ? a.kwhPerKm : Infinity;
    const kb = isNum(b.kwhPerKm) ? b.kwhPerKm : Infinity;
    return ka - kb;
  });
  const returnDistanceKm = returnTripDistanceKm(fleet);
  const plugHandlingMin = fleet.parameters?.site?.plugHandlingMinutes ?? 10;

  return (
    <>
      <Feedback
        feedback="The model simulates four energy scenarios for the proposed route, each with a different consumption rate per km. Real draw depends on route makeup, distance, and seasonal change. In the low scenario, the route is feasible with margin, at breakeven, there remains a 10% buffer on final return to depot; central falls just above the buffer threshold and high makes the route infeasible."
        improvementsTitle="Suggestions"
        improvements={[
          "Treat the central consumption scenario as the planning case, worthwhile to do a real-world run or use existing company data to make better estimations of consumption rate for the route. Route length might have to be reduced to make more margin for service launching in winter season.",
          "The route must be adjusted if real-world consumption rate is closer to 1.50 kWh/km as in the high consumption model scenario.",
          "Ensure two cables are available for charging at all times as dual cable charging allows all 8 services to be ran with 5 vehicles where as single cable charging would require 6.",
          "Prepare spare cables for emergency use in case of a cable fault.",
        ]}
        considerations={
          [
            {
              label: "Charging taper",
              text: "Power typically tapers above ~80% SoC; recharge times here assume flat 180 kW per cable plus 10 min plug handling, so real sessions may run longer than the Gantt shows.",
            },
            {
              label: "Temperature & HVAC",
              text: "Winter heating and summer cooling can add materially to consumption on long motorway legs, the central scenario already sits below the 10% buffer floor.",
            },
            {
              label: "Battery degradation",
              text: "Usable capacity shrinks with age and cycle count so planning at 90% of nominal pack leaves limited headroom, best to use actual battery capacity from the fleet.",
            },
          ] satisfies ConsiderationItem[]
        }
      />

      <Panel title="Energy usage">
        <div className="stats">
          <Stat
            compact
            label="Battery capacity"
            value={`${num(vehicle.batteryKwh)} kWh`}
            sub={
              isNum(headroomKwh) && isNum(floor)
                ? `${num(headroomKwh)} kWh = 90% of full capacity`
                : undefined
            }
          />
          <Stat
            compact
            label="Outbound + return distance"
            value={`${num(returnDistanceKm, 1)} km`}
            sub={`source: ${fleet.distance?.source ?? "–"}`}
          />
          {chargeToFullStat(1, floor, fleet.charging, plugHandlingMin, headroomKwh)}
          {chargeToFullStat(2, floor, fleet.charging, plugHandlingMin, headroomKwh)}
        </div>
        <div style={{ marginTop: 12 }}>
          <DataTable
            rows={energyRows}
            rowKey={(r) => r.s}
            rowClassName={(r) => (r.s === "break-even" ? "row-highlight" : undefined)}
            columns={[
              {
                key: "s",
                header: "Scenario",
                render: (r) => <b>{r.s === "break-even" ? "break-even" : r.s}</b>,
              },
              {
                key: "k",
                header: "Consumption Rate",
                unit: "kWh/km",
                render: (r) => num(r.kwhPerKm, 2),
                num: true,
              },

              {
                key: "e",
                header: "Energy Consumption",
                unit: "kWh",
                render: (r) => num(r.energyKwh),
                num: true,
              },
              {
                key: "p",
                header: "Battery used",
                unit: "%",
                title:
                  "Share of the full pack used by one outbound + return trip; 90% is the planning limit (10% buffer); above 100% exceeds pack capacity",
                render: (r) => {
                  const overPlan = isNum(r.packUsePct) && r.packUsePct > 90;
                  return (
                    <span
                      style={
                        overPlan ? { color: "var(--bad)", fontWeight: 600 } : undefined
                      }
                    >
                      {isNum(r.packUsePct) ? num(r.packUsePct, 1) : "–"}
                    </span>
                  );
                },
                num: true,
              },
              {
                key: "soc",
                header: "SoC on return",
                unit: "%",
                title: isNum(floor)
                  ? `Modelled return SoC; ${pct(floor)} buffer flagged when breached`
                  : undefined,
                render: (r) => {
                  const below =
                    isNum(r.socOnReturn) && isNum(floor) && r.socOnReturn < floor;
                  return (
                    <span
                      style={below ? { color: "var(--bad)", fontWeight: 600 } : undefined}
                    >
                      {isNum(r.socOnReturn) ? num(r.socOnReturn * 100, 1) : "–"}
                    </span>
                  );
                },
                num: true,
              },
              {
                key: "f",
                header: "10% buffer remains",
                title:
                  "Whether return SoC stays at or above the 10% reserve floor after one outbound + return; break-even row sits exactly on that limit",
                render: (r) =>
                  r.s === "break-even" ? (
                    <Badge kind="neutral">At limit</Badge>
                  ) : r.feasible == null ? (
                    "–"
                  ) : r.feasible ? (
                    <Badge kind="ok">yes</Badge>
                  ) : (
                    <Badge kind="bad">no</Badge>
                  ),
              },
            ]}
          />
        </div>
      </Panel>

      <Panel title="Vehicle pattern" sub="07:00 – 07:00 service day">
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "center",
            marginBottom: 10,
            flexWrap: "wrap",
          }}
        >
          <Seg
            value={scenario}
            onChange={setScenario}
            options={SCENARIOS.map((s) => ({
              value: s,
              label: `${s} (${num(fleet.energy?.[s]?.kwhPerKm, 2)} kWh/km)`,
            }))}
          />
          <Seg
            value={cables}
            onChange={setCables}
            options={[
              { value: "1", label: "1 cable" },
              { value: "2", label: "2 cables" },
            ]}
          />
          {sc?.unassignedColumns?.length &&
          !isExceedsPackNotice(
            sc.unassignedColumns,
            fleet.energy?.[scenario]?.energyKwh,
            vehicle.batteryKwh,
          ) ? (
            <Badge kind="bad">{unassignedBadge(sc.unassignedColumns)}</Badge>
          ) : null}
        </div>
        {sc ? (
          <Gantt sc={sc} fixedRows={maxVehicleRows} />
        ) : (
          <div
            className="gantt gantt-fixed"
            style={{ minHeight: ganttPanelHeight(maxVehicleRows) }}
          >
            <Empty>No scenario data.</Empty>
          </div>
        )}
        {sc?.unassignedColumns?.length ? (
          <UnassignedNotice
            unassigned={sc.unassignedColumns}
            tripEnergyKwh={fleet.energy?.[scenario]?.energyKwh}
            batteryKwh={vehicle.batteryKwh}
          />
        ) : null}
      </Panel>
      <DriversShiftCheck cols={doc.timetableColumns ?? []} />
    </>
  );
}
