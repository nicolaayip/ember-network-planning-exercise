declare module "@engine/lib/polyline.js" {
  export function decodePolyline(encoded: string): [number, number][];
}

declare module "@engine/domain/block-scheduler.js" {
  export const FLEET_DAY_START_MIN: number;
  export const FLEET_DAY_END_MIN: number;

  export interface EngineScheduleColumn {
    columnId: string;
    depotDeparture: number;
    depotArrival: number;
  }

  export interface EngineScheduleInput {
    columns: EngineScheduleColumn[];
    energyPerReturnKwh: number;
    vehicle: { batteryKwh: number; socFloor: number; maxChargePowerKw: number };
    site: {
      cables: number;
      cablePowerKw: number;
      maxCablesPerVehicle: number;
      plugHandlingMinutes: number;
    };
    slotMinutes?: number;
    dayStartMin?: number;
    dayEndMin?: number;
  }

  export interface EngineScheduleResult {
    vehiclesRequired: number;
    vehicles: Array<{
      id: string;
      columnIds: string[];
      blocks: Array<Record<string, unknown>>;
      socEndOfDay?: number;
    }>;
    unassignedColumns: Array<{ columnId: string; reason?: string }>;
    energy: {
      energyPerReturnKwh: number;
      socOnReturn: number;
      returnFeasible: boolean;
    };
    cables: {
      perSlot: number[];
      peak: number;
      capacity: number;
      withinCapacity: boolean;
    };
    grid: { dayStart: number; dayEnd: number; slotMinutes: number; slots: number };
  }

  export function scheduleBlocks(p: EngineScheduleInput): EngineScheduleResult;
}

declare module "@engine/domain/temporal-windows.js" {
  export function trafficSamplePeriodLabel(period?: {
    label?: string;
    windowMonths?: number;
    launchLeadDays?: number;
    windows?: Array<{ start?: string; end?: string }>;
  }): string;
}

declare module "@engine/domain/traffic-bands.js" {
  export interface EngineTrafficBand {
    id: string;
    kind?: "peak" | "valley";
    start?: string;
    end?: string;
    apex?: string;
    apexPctPerHour?: number;
  }

  export function bandLabel(band?: EngineTrafficBand): string;
  export function bandPeriodLabel(band?: EngineTrafficBand): string;
  export function baselineSampleId(bands?: EngineTrafficBand[]): string;
}
