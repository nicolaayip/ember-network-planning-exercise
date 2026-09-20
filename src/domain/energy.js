/**
 * Energy model (DESIGN_DOC §5.2). Pure functions.
 *
 * Question answered: can a coach complete one return trip (plus depot dead legs) on one
 * charge, under low / central / high consumption, and with what state of charge on return?
 */

export const FULL_SOC = 1;

/**
 * @param {object} p
 * @param {number} p.returnTripKm        passenger route distance out + back
 * @param {number} [p.deadKm=0]          depot ↔ first/last stop dead running, both ends summed
 * @param {number} [p.depotToChargerKm=0] extra dead running if chargers are not at the depot (both ways summed)
 * @param {number} p.kwhPerKm
 * @param {{ batteryKwh: number, socFloor: number }} p.vehicle
 */
export function energyForReturn(p) {
  const totalKm = p.returnTripKm + (p.deadKm ?? 0) + (p.depotToChargerKm ?? 0);
  const energyKwh = totalKm * p.kwhPerKm;
  const usableKwh = p.vehicle.batteryKwh * (FULL_SOC - p.vehicle.socFloor);
  const socOnReturn = FULL_SOC - energyKwh / p.vehicle.batteryKwh;
  return {
    totalKm: round1(totalKm),
    kwhPerKm: p.kwhPerKm,
    energyKwh: round1(energyKwh),
    usableKwh: round1(usableKwh),
    socStart: FULL_SOC,
    socFloor: p.vehicle.socFloor,
    socOnReturn: round3(socOnReturn),
    marginKwh: round1(usableKwh - energyKwh),
    feasible: socOnReturn >= p.vehicle.socFloor,
    /** Could the vehicle do a second return without charging? */
    twoReturnsFeasible: 2 * energyKwh <= usableKwh,
  };
}

/**
 * Run energyForReturn for each named consumption scenario.
 * @param {Record<string, number>} scenarios  e.g. { low: 1.0, central: 1.25, high: 1.5 }
 */
export function energyScenarios(base, scenarios) {
  const out = {};
  for (const [name, kwhPerKm] of Object.entries(scenarios)) out[name] = energyForReturn({ ...base, kwhPerKm });
  return out;
}

/** Break-even consumption (kWh/km) at which return SoC hits the reserve floor. */
export function breakEvenKwhPerKm(base) {
  const totalKm = base.returnTripKm + (base.deadKm ?? 0) + (base.depotToChargerKm ?? 0);
  const usableKwh = base.vehicle.batteryKwh * (FULL_SOC - base.vehicle.socFloor);
  return round3(usableKwh / totalKm);
}

const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
