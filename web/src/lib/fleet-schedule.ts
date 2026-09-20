/** @format */

import { scheduleBlocks as engineScheduleBlocks } from "@engine/domain/block-scheduler.js";
import type { EngineScheduleInput } from "@engine/domain/block-scheduler.js";
import type { EngineDocument, Fleet, FleetScenario, ScenarioName, Vehicle } from "../types";
import { isNum, parseHHMM } from "./format";

const DEFAULT_MAX_CHARGE_KW = 600;
const DEFAULT_SITE_CABLES = 4;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface ScheduleColumn {
  columnId: string;
  depotDeparture: number;
  depotArrival: number;
}

function fleetColumns(doc: EngineDocument): ScheduleColumn[] {
  return (doc.timetableColumns ?? [])
    .map((c) => {
      const depotDeparture =
        parseHHMM(c.depotDeparture) ?? parseHHMM(c.outboundDeparture);
      const depotArrival = parseHHMM(c.depotArrival) ?? parseHHMM(c.returnArrival);
      if (depotDeparture == null || depotArrival == null) return null;
      return { columnId: c.columnId, depotDeparture, depotArrival };
    })
    .filter((c): c is ScheduleColumn => c != null);
}

function fleetSite(fleet: Fleet, maxCablesPerVehicle: 1 | 2) {
  const cablePowerKw = fleet.charging?.["1"]?.powerKw ?? 180;
  return {
    cables: DEFAULT_SITE_CABLES,
    cablePowerKw,
    maxCablesPerVehicle,
    plugHandlingMinutes: fleet.parameters?.site?.plugHandlingMinutes ?? 10,
  };
}

function fleetVehicleParams(fleet: Fleet) {
  const v = fleet.parameters?.vehicle;
  return {
    batteryKwh: v?.batteryKwh ?? 621,
    socFloor: v?.socFloor ?? fleet.energy?.central?.socFloor ?? 0.1,
    maxChargePowerKw: DEFAULT_MAX_CHARGE_KW,
  };
}

function toFleetScenario(
  result: ReturnType<typeof engineScheduleBlocks>,
  batteryKwh: number,
): FleetScenario {
  return {
    vehiclesRequired: result.vehiclesRequired,
    returnFeasible: result.energy.returnFeasible,
    requiredSocWindow: round3(result.energy.energyPerReturnKwh / batteryKwh),
    socOnReturn: result.energy.socOnReturn,
    unassignedColumns: result.unassignedColumns,
    peakCablesInUse: result.cables.peak,
    cablesWithinCapacity: result.cables.withinCapacity,
    cablesPerSlot: result.cables.perSlot,
    vehicles: result.vehicles as unknown as Vehicle[],
    grid: result.grid,
  };
}

export function scheduleBlocks(input: EngineScheduleInput): FleetScenario {
  return toFleetScenario(engineScheduleBlocks(input), input.vehicle.batteryKwh);
}

function scheduleFleetColumnsInternal(
  fleet: Fleet,
  columns: ScheduleColumn[],
  scenario: ScenarioName,
  maxCablesPerVehicle: 1 | 2,
) {
  const energyKwh = fleet.energy?.[scenario]?.energyKwh;
  if (!columns.length || !isNum(energyKwh)) return null;

  const slotMinutes =
    fleet.scenarios?.[scenario]?.grid?.slotMinutes ??
    fleet.scenarios?.central?.grid?.slotMinutes ??
    15;

  return scheduleBlocks({
    columns,
    energyPerReturnKwh: energyKwh,
    vehicle: fleetVehicleParams(fleet),
    site: fleetSite(fleet, maxCablesPerVehicle),
    slotMinutes,
  });
}

/** Block-scheduler vehicle count for an arbitrary column set (same model as Fleet tab). */
export function scheduleFleetColumns(
  fleet: Fleet,
  columns: ScheduleColumn[],
  scenario: ScenarioName,
  maxCablesPerVehicle: 1 | 2,
) {
  return scheduleFleetColumnsInternal(fleet, columns, scenario, maxCablesPerVehicle);
}

export function fleetVehicleRange(
  fleet: Fleet,
  columns: ScheduleColumn[],
  scenario: ScenarioName = "central",
) {
  const oneCable = scheduleFleetColumnsInternal(fleet, columns, scenario, 1)?.vehiclesRequired;
  const twoCable = scheduleFleetColumnsInternal(fleet, columns, scenario, 2)?.vehiclesRequired;
  if (!isNum(oneCable) && !isNum(twoCable)) return null;
  const counts = [oneCable, twoCable].filter(isNum);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const range = min === max ? String(min) : `${min}–${max}`;
  const sub =
    isNum(oneCable) && isNum(twoCable)
      ? `${twoCable} with 2 cables, ${oneCable} with 1`
      : "dependent on cable availability";
  return { range, sub, min, max };
}

export function scheduleFleetScenario(
  doc: EngineDocument,
  fleet: Fleet,
  scenario: ScenarioName,
  maxCablesPerVehicle: 1 | 2,
) {
  return scheduleFleetColumnsInternal(fleet, fleetColumns(doc), scenario, maxCablesPerVehicle);
}
