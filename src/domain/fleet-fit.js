/**
 * Fleet fit (DESIGN_DOC §4.5 step 2). Pure function.
 *
 * Demand greedy discovers candidate columns without a vehicle cap. This step schedules the
 * discovered set (departure order via block-scheduler) and drops the lowest-marginal services
 * until the remainder fits within the fleet cap — a different question from capping greedy itself.
 */

/**
 * @param {Array<{ columnId?: string, marginalGain?: number, outboundDeparture?: number }>} columns
 * @param {number|null|undefined} cap
 * @param {(cols: typeof columns) => number} vehiclesFor
 */
export function fitFleetCap(columns, cap, vehiclesFor) {
  if (!columns.length) {
    return { columns: [], dropped: [], vehiclesRequired: 0 };
  }
  if (cap == null) {
    return { columns: [...columns], dropped: [], vehiclesRequired: vehiclesFor(columns) };
  }

  let remaining = [...columns];
  const dropped = [];
  let vehicles = vehiclesFor(remaining);

  while (remaining.length > 1 && vehicles > cap) {
    let worstIdx = 0;
    for (let i = 1; i < remaining.length; i++) {
      const mg = remaining[i].marginalGain ?? 0;
      const wmg = remaining[worstIdx].marginalGain ?? 0;
      if (mg < wmg) worstIdx = i;
    }
    dropped.push(remaining.splice(worstIdx, 1)[0]);
    vehicles = vehiclesFor(remaining);
  }

  return { columns: remaining, dropped, vehiclesRequired: vehicles };
}
