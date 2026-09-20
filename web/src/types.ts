/**
 * Shape of one engine run (output/<routeId>.json), mirroring .cursor/DATA_SCHEMA.json.
 * Everything beyond the required core is optional: the dashboard must render partial documents
 * while the engine is still filling phases in.
 *
 * @format
 */

/** Traffic sample id: band id (peak1, valley1, …) or weekend. */
export type TrafficSampleId = string;
export type ScenarioName = "low" | "central" | "high";
export type DirectionName = "outbound" | "return";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface CatchmentZone {
  code: string;
  name?: string;
  zonePopulation?: number;
  ratio?: number;
  allocated?: number;
}

export interface Catchment {
  walkSeconds?: number;
  areaKm2?: number;
  population?: number;
  country?: string;
  zones?: CatchmentZone[];
  polygon?: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

export interface Stop {
  sequenceOrder: number;
  naptanId: string;
  /** "depot" = first point of outbound / last of return: routed and timed, never a calling point. */
  role?: "passenger" | "depot";
  stopName: string;
  localityName?: string;
  coordinates: LatLng;
  dwellTimeBufferSeconds?: number;
  alwaysServed?: boolean;
  proposedTimes?: string[];
  deviationMinutes?: number | null;
  deviationKm?: number | null;
  isSingleCarriageway?: boolean;
  carriagewayKind?: "urban" | "single" | "dual";
  hasBusLane?: boolean;
  catchment?: Catchment;
  poi?: { weekday?: number; weekend?: number };
}

export interface LegWindow {
  durationMin?: number;
  staticDurationMin?: number;
}

export interface Leg {
  fromStopId: string;
  toStopId: string;
  /** Depot → first stop or last stop → depot (§5.1). */
  deadLeg?: boolean;
  distanceKm?: number;
  /** Central per-leg factor from carriageway kind (engine-stamped). */
  coachSpeedFactor?: number;
  windows?: Partial<Record<TrafficSampleId, LegWindow>>;
  coachAdjustedMin?: Partial<Record<ScenarioName, number>>;
  proposedMin?: number | null;
  deltaMin?: number | null;
}

/** Engine supplyVector.calculatedHeadwayGaps (DATA_SCHEMA.json). */
export interface HeadwayGap {
  gapStart?: string;
  gapEnd?: string;
  durationMinutes?: number;
  isMarketOpening?: boolean;
  /** Minutes of gap overlapping a WebTRIS peak band (when peak-filtered). */
  peakOverlapMinutes?: number;
}

export interface CompetitorDeparture {
  time: string;
  service: string;
}

export interface ODPair {
  pairId: string;
  originStopId: string;
  destinationStopId: string;
  simulatedTravelTimeMinutes?: number;
  simulatedTravelTimeBySample?: Partial<Record<TrafficSampleId, number>>;
  coachPathKm?: number;
  directCarKm?: number;
  pathDetourRatio?: number;
  pathDetourWarning?: boolean;
  dwellMinutesBetween?: number;
  directCarDriveMinutes?: number;
  directCarStaticDriveMinutes?: number;
  demandVector?: {
    offPeakWeekday?: {
      proportionalRetainedPopulation?: number;
      destinationPoiGravityScore?: number;
      calculatedWeekdayGravityPotential?: number;
    };
    offPeakWeekend?: {
      proportionalRawResidentPopulation?: number;
      destinationPoiWeekendGravityScore?: number;
      calculatedWeekendGravityPotential?: number;
    };
  };
  supplyVector?: {
    detectedOverlappingLines?: string[];
    saturdayDetectedOverlappingLines?: string[];
    calculatedHeadwayGaps?: HeadwayGap[];
    saturdayHeadwayGaps?: HeadwayGap[];
    competitorDepartures?: CompetitorDeparture[];
    saturdayCompetitorDepartures?: CompetitorDeparture[];
  };
}

export interface Direction {
  label?: string;
  orderedStops: Stop[];
  directionalODPairs?: ODPair[];
  legs?: Leg[];
  endToEndMin?: Partial<Record<TrafficSampleId, number>>;
  routePolyline?: string;
}

export interface TimetableColumn {
  columnId: string;
  outboundDeparture: string;
  returnDeparture: string;
  depotDeparture?: string;
  depotArrival?: string;
  outboundArrival?: string;
  returnArrival?: string;
  layoverMinutes?: number;
  columnScore?: number;
  /** Weekend (Saturday competitor) column score when peak-filtered openings apply. */
  columnScoreWeekend?: number;
  driving?: {
    outboundDrivingMinutes?: number;
    returnDrivingMinutes?: number;
    dailyDrivingMinutes?: number;
    dutyMinutes?: number;
    layoverSlackMinutes?: number;
    /** Longest working stint before the layover break (RT(WT)R 2005 · ≤ 6 h). */
    continuousWorkingMinutes?: number;
  };
  checks?: Record<string, boolean>;
  /** Dead-leg allowance vs routed time (§5.1); present when the depot is routed. */
  deadLegs?: { toFirstStop?: DeadLegCheck; fromLastStop?: DeadLegCheck };
  source?: "proposed" | "recommended";
}

export interface DeadLegCheck {
  allowanceMin: number;
  routedMin: number;
  band: TrafficSampleId;
  distanceKm?: number;
  slackMin: number;
}

export interface TrafficBand {
  id: string;
  kind: "peak" | "valley";
  start: string;
  end: string;
  apex: string;
  apexPctPerHour?: number;
}
export interface TrafficSite {
  id: number | string;
  name?: string;
  direction?: string;
  /** WebTRIS counter WGS84 — present from engine runs after lat/lng persistence. */
  lat?: number;
  lng?: number;
  segment?: string;
  nearestStop?: string;
  weekdayCoverage?: number;
  vehiclesPerWeekday?: number;
  vehiclesPerWeekendDay?: number;
  weekdayBands?: TrafficBand[];
  weekdayHourlyPct?: number[];
  weekendHourlyPct?: number[];
  /** 15-minute share of daily flow (%); matches detectBands granularity. */
  weekdayQuarterHourPct?: number[];
  weekendQuarterHourPct?: number[];
}
export interface TrafficBasisSite extends TrafficSite {
  serviceDirection?: DirectionName;
  compass?: string;
  anchorStopName?: string;
  /** Distance from counter to the Google route polyline (metres), when refined post-topology. */
  routeDistanceM?: number | null;
  yearsUsed?: number[] | null;
  profileKind?: string;
  dayMeanPctPerHour?: number;
  weekendBusyHour?: WeekendBusyHour;
  perYear?: Array<{
    year: number;
    weekdays?: number;
    vehPerWeekday?: number;
    peaks?: string[];
    profileKind?: string;
  }>;
}
export interface WeekendBusyHour {
  /** Peak band edges at 80% of apex (same as weekday detectBands). */
  start?: string;
  end?: string;
  apex?: string;
  /** Legacy alias for apex — kept for older scenario JSON. */
  busyHourStart?: string;
  apexPctPerHour?: number;
  profileKind?: string;
  pctOfDay?: number;
  pctPerHour?: number;
  vsDayMean?: number;
}
export interface ServiceTemporalWindows {
  weekdayBands?: TrafficBand[];
  profileKind?: string;
  weekendDeparture?: string;
  weekendPeakBand?: TrafficBand;
  basisSiteId?: number;
  anchorStopName?: string;
  compass?: string;
}
export interface TemporalWindows {
  source?: string;
  outbound?: ServiceTemporalWindows;
  return?: ServiceTemporalWindows;
}
export interface TrafficSeries {
  weekdayHourlyPct?: number[];
  weekendHourlyPct?: number[];
  weekdayBands?: TrafficBand[];
  sites?: Array<number | string>;
}
export interface TrafficProfile {
  source?: string;
  period?: {
    /** @deprecated display copy — use trafficSamplePeriodLabel() in the web app */
    label?: string;
    launchDate?: string;
    launchLeadDays?: number;
    windowMonths?: number;
    start?: string;
    weeks?: number;
    windows?: Array<{ year: number; start: string; end?: string }>;
    excludedDates?: number;
  };
  coverage?: { corridorKmWithSites?: number; corridorKmTotal?: number };
  windowsBasis?: string;
  outboundCompassDirection?: string;
  basisSites?: TrafficBasisSite[];
  /** @deprecated use basisSites */
  sites?: TrafficSite[];
  /** @deprecated use basisSites */
  corridor?: TrafficSeries;
  /** @deprecated use basisSites */
  byDirection?: Record<string, TrafficSeries>;
}

export interface EnergyScenario {
  totalKm?: number;
  kwhPerKm?: number;
  energyKwh?: number;
  usableKwh?: number;
  socStart?: number;
  socFloor?: number;
  socOnReturn?: number;
  marginKwh?: number;
  feasible?: boolean;
  twoReturnsFeasible?: boolean;
}
export interface FleetVehicleParams {
  model?: string;
  batteryKwh?: number;
  socFloor?: number;
}
export interface ChargeOption {
  minutes?: number;
  chargingMinutes?: number;
  plugHandlingMinutes?: number;
  energyKwh?: number;
  powerKw?: number;
}
export interface Block {
  type: "trip" | "charge" | "idle" | "dead" | string;
  columnId?: string;
  start: number;
  end: number;
  socStart?: number;
  socEnd?: number;
  cables?: number;
  powerKw?: number;
  startHHMM?: string;
  endHHMM?: string;
}
export interface Vehicle {
  id: string;
  columnIds?: string[];
  blocks: Block[];
  socEndOfDay?: number;
}
export interface FleetScenario {
  vehiclesRequired?: number;
  returnFeasible?: boolean;
  requiredSocWindow?: number;
  note?: string;
  socOnReturn?: number;
  unassignedColumns?: Array<{ columnId: string; reason?: string }>;
  peakCablesInUse?: number;
  cablesWithinCapacity?: boolean;
  cablesPerSlot?: number[];
  vehicles?: Vehicle[];
  grid?: { dayStart: number; dayEnd: number; slotMinutes: number; slots: number };
}
export interface Fleet {
  distance?: {
    oneWayKm?: Partial<Record<DirectionName, number>>;
    returnTripKm?: number;
    deadKm?: number;
    source?: string;
  };
  energy?: Partial<Record<ScenarioName, EnergyScenario>>;
  breakEvenKwhPerKm?: number;
  charging?: Record<string, ChargeOption>;
  scenarios?: Partial<Record<ScenarioName, FleetScenario>>;
  parameters?: { vehicle?: FleetVehicleParams; site?: { plugHandlingMinutes?: number } };
}

export interface Assumption {
  key?: string;
  parameter?: string;
  value?: unknown;
  unit?: string;
  low?: unknown;
  high?: unknown;
  source?: string;
  sourceUrl?: string;
  retrieved?: string;
  section?: string;
  note?: string;
}

export interface SelectionCurvePoint {
  n?: number;
  cumulative?: number;
  marginal?: number;
}

export interface SelectionColumnEval {
  columnId?: string;
  outboundDeparture?: string;
  outboundArrival?: string;
  returnDeparture?: string;
  returnArrival?: string;
  layoverMinutes?: number;
  standaloneScore?: number;
  incrementalScore?: number;
  marginalGain?: number;
  cumulative?: number;
  pairsInOpenings?: number;
  outboundPairsInOpenings?: number;
  returnPairsInOpenings?: number;
  bands?: Record<string, string>;
}

export interface SelectionDayResult {
  basis?: string;
  cumulative?: number;
  columns?: SelectionColumnEval[];
}

export interface FleetFitResult {
  cap?: number;
  basis?: string;
  columns?: SelectionColumnEval[];
  cumulative?: number;
  vehiclesRequired?: number;
  dropped?: Array<{
    columnId?: string;
    outboundDeparture?: string;
    marginalGain?: number;
  }>;
}

export interface SelectionRecommended extends SelectionDayResult {
  curve?: SelectionCurvePoint[];
  fleetCap?: number;
  vehiclesRequired?: number;
  fleetFit?: FleetFitResult;
  columnsWithinCap?: number;
  cumulativeWithinCap?: number;
}

export interface SlotRankingCandidate extends SelectionColumnEval {
  rank?: number;
  newGapHits?: number;
  cumulativeGapHits?: number;
}

export interface SlotRankingSelected {
  columns?: SlotRankingCandidate[];
  vehiclesRequired?: number;
  curve?: Array<{ n?: number; newHits?: number; cumulativeHits?: number }>;
  stopReason?: string;
}

export interface SlotRankingResult {
  basis?: string;
  candidates?: SlotRankingCandidate[];
  selected?: SlotRankingSelected;
}

export interface TimetableSelection {
  thresholdMinutes?: number;
  fleetCap?: { cap?: number; basis?: string; proposalVehicles?: number };
  weekday?: {
    proposal?: SelectionDayResult;
    recommended?: SelectionRecommended;
    slotRanking?: SlotRankingResult;
  };
  weekend?: {
    proposal?: SelectionDayResult;
    recommended?: SelectionRecommended;
    slotRanking?: SlotRankingResult;
  };
}

/** Row for proposed / recommended timetable tables. */
export interface TimetableDisplayRow {
  columnId: string;
  outboundDeparture: string;
  outboundArrival?: string;
  returnDeparture: string;
  returnArrival?: string;
  depotDeparture?: string;
  depotArrival?: string;
  layoverMinutes?: number;
  incrementalScore?: number;
  pairsInOpenings?: number;
  outboundPairsInOpenings?: number;
  returnPairsInOpenings?: number;
  marginalGain?: number;
  rank?: number;
  newGapHits?: number;
  cumulativeGapHits?: number;
  /** Set when fleet-fit step 2 drops this discovered column. */
  fleetDropped?: boolean;
}

export interface EngineDocument {
  routeId: string;
  routeName: string;
  mode?: "evaluate" | "propose";
  daysOfOperation?: string;
  estimatedTemporalWindows?: TemporalWindows;
  directions: Record<DirectionName, Direction>;
  timetableColumns: TimetableColumn[];
  timetableSelection?: TimetableSelection;
  trafficProfile?: TrafficProfile;
  fleet?: Fleet;
  assumptions?: Assumption[];
  generatedAt?: string;
}

export interface ScenarioMeta {
  id: string;
  label: string;
  file: string;
  pins?: string;
  description?: string;
}

/** A placemark from the interviewer's KMZ (Google My Maps): layer = "Outbound" / "Return". */
export interface ReferencePin {
  layer: string;
  seq: number;
  name: string;
  lat: number;
  lng: number;
}
export interface ReferencePins {
  source?: string;
  pins: ReferencePin[];
}
