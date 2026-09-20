/**
 * Charging model (DESIGN_DOC §5.3). Pure functions.
 *
 * Site: N cables of P kW each; a vehicle may take up to `maxCablesPerVehicle`; the vehicle's own
 * limit caps the draw. Recharge time is energy ÷ effective power, plus plug handling per session.
 */

/**
 * Effective power for a vehicle on `cables` cables.
 */
export function effectivePowerKw(cables, site, vehicle) {
  const n = Math.min(cables, site.maxCablesPerVehicle);
  return Math.min(n * site.cablePowerKw, vehicle.maxChargePowerKw);
}

/**
 * Minutes to charge from `socFrom` to `socTo` on `cables` cables, with plug handling.
 * @returns {{ minutes: number, chargingMinutes: number, plugHandlingMinutes: number, energyKwh: number, powerKw: number }}
 */
export function chargeTime({ socFrom, socTo, cables, site, vehicle }) {
  if (socTo <= socFrom) return { minutes: 0, chargingMinutes: 0, plugHandlingMinutes: 0, energyKwh: 0, powerKw: effectivePowerKw(cables, site, vehicle) };
  const powerKw = effectivePowerKw(cables, site, vehicle);
  const energyKwh = (socTo - socFrom) * vehicle.batteryKwh;
  const chargingMinutes = Math.round((energyKwh / powerKw) * 60);
  const plugHandlingMinutes = site.plugHandlingMinutes;
  return {
    minutes: chargingMinutes + plugHandlingMinutes,
    chargingMinutes,
    plugHandlingMinutes,
    energyKwh: Math.round(energyKwh * 10) / 10,
    powerKw,
  };
}

/**
 * Charge time for every cable configuration 1..maxCablesPerVehicle.
 */
export function chargeTimeByCables(args) {
  const out = {};
  for (let c = 1; c <= args.site.maxCablesPerVehicle; c++) out[c] = chargeTime({ ...args, cables: c });
  return out;
}
