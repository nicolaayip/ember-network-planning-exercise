/**
 * Drivers' hours checks for one timetable column (DESIGN_DOC §5.4). Pure functions.
 *
 * A column is one driver's shift: depot → outbound run → layover → return run → depot.
 * Assimilated EU rules for regular services > 50 km: ≤ 4.5 h continuous driving before a
 * 45-minute break; ≤ 9 h daily driving; the Edinburgh layover is the break.
 */

/**
 * @param {object} col   minutes from service-day start
 * @param {number} [col.depotDeparture]
 * @param {number} col.outboundDeparture   first passenger stop departure
 * @param {number} col.outboundArrival     last passenger stop arrival
 * @param {number} col.returnDeparture
 * @param {number} col.returnArrival
 * @param {number} [col.depotArrival]
 * @param {{ maxContinuousDrivingMinutes: number, maxContinuousWorkingMinutes: number, minBreakMinutes: number, maxDailyDrivingMinutes: number }} rules
 */
export function checkColumn(col, rules) {
  const deadOut = col.depotDeparture !== undefined ? col.outboundDeparture - col.depotDeparture : 0;
  const deadIn = col.depotArrival !== undefined ? col.depotArrival - col.returnArrival : 0;
  const outboundDriving = deadOut + (col.outboundArrival - col.outboundDeparture);
  const returnDriving = (col.returnArrival - col.returnDeparture) + deadIn;
  const layover = col.returnDeparture - col.outboundArrival;
  const dailyDriving = outboundDriving + returnDriving;
  const duty = (col.depotArrival ?? col.returnArrival) - (col.depotDeparture ?? col.outboundDeparture);

  const layoverAtLeastBreak = layover >= rules.minBreakMinutes;
  // Each driving stint must fit within the continuous limit; the layover is the only break.
  const stintsWithinLimit =
    outboundDriving <= rules.maxContinuousDrivingMinutes && returnDriving <= rules.maxContinuousDrivingMinutes;
  const dailyWithinLimit = dailyDriving <= rules.maxDailyDrivingMinutes;
  // RT(WT)R 2005 reg 7 — no working > 6 h without a break; layover is the break.
  const continuousWorking = Math.max(outboundDriving, returnDriving);
  const continuousWorkingWithinLimit =
    continuousWorking <= rules.maxContinuousWorkingMinutes;

  return {
    outboundDrivingMinutes: outboundDriving,
    returnDrivingMinutes: returnDriving,
    layoverMinutes: layover,
    dailyDrivingMinutes: dailyDriving,
    dutyMinutes: duty,
    layoverSlackMinutes: layover - rules.minBreakMinutes,
    continuousWorkingMinutes: continuousWorking,
    checks: {
      layoverAtLeast45Min: layoverAtLeastBreak,
      continuousDrivingWithin4h30: stintsWithinLimit,
      continuousWorkingWithin6h: continuousWorkingWithinLimit,
      dailyDrivingWithin9h: dailyWithinLimit,
    },
    legal:
      layoverAtLeastBreak &&
      stintsWithinLimit &&
      continuousWorkingWithinLimit &&
      dailyWithinLimit,
  };
}
