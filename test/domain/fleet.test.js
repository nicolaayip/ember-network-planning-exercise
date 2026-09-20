/** @format */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  energyForReturn,
  energyScenarios,
  breakEvenKwhPerKm,
} from "../../src/domain/energy.js";
import { chargeTime, effectivePowerKw } from "../../src/domain/charging.js";
import { checkColumn } from "../../src/domain/drivers-hours.js";
import { scheduleBlocks } from "../../src/domain/block-scheduler.js";
import { parseHHMM, formatHHMM, formatClock } from "../../src/lib/time.js";

const vehicle = { batteryKwh: 621, maxChargePowerKw: 600, socFloor: 0.1 };
const site = {
  cables: 4,
  cablePowerKw: 180,
  maxCablesPerVehicle: 2,
  plugHandlingMinutes: 10,
};
const rules = {
  maxContinuousDrivingMinutes: 270,
  maxContinuousWorkingMinutes: 360,
  minBreakMinutes: 45,
  maxDailyDrivingMinutes: 540,
};

describe("time helpers", () => {
  test("parse/format round-trip including service-day notation", () => {
    assert.equal(parseHHMM("07:15"), 435);
    assert.equal(parseHHMM("25:22"), 1522);
    assert.equal(formatHHMM(1522), "25:22");
    assert.equal(formatClock(1522), "01:22 (+1)");
    assert.throws(() => parseHHMM("7.15"), TypeError);
  });
});

describe("energy", () => {
  test("usable energy is full pack minus 10% reserve = 558.9 kWh", () => {
    const e = energyForReturn({ returnTripKm: 400, kwhPerKm: 1.0, vehicle });
    assert.equal(e.usableKwh, 558.9);
    assert.equal(e.energyKwh, 400);
    assert.equal(e.socStart, 1);
    assert.equal(e.feasible, true);
    assert.equal(e.twoReturnsFeasible, false);
    assert.ok(Math.abs(e.socOnReturn - (1 - 400 / 621)) < 1e-3);
  });
  test("dead km and depot-to-charger km add to the total", () => {
    const e = energyForReturn({
      returnTripKm: 400,
      deadKm: 6,
      depotToChargerKm: 4,
      kwhPerKm: 1.2,
      vehicle,
    });
    assert.equal(e.totalKm, 410);
    assert.equal(e.energyKwh, 492);
  });
  test("high 1.5 kWh/km on ~400 km drops below the 10% floor", () => {
    const s = energyScenarios(
      { returnTripKm: 396, deadKm: 6, vehicle },
      { low: 1.0, central: 1.25, high: 1.5 },
    );
    assert.equal(s.low.feasible, true);
    assert.equal(s.central.feasible, true);
    assert.equal(s.high.feasible, false);
    assert.ok(
      Math.abs(
        breakEvenKwhPerKm({ returnTripKm: 396, deadKm: 6, vehicle }) - 558.9 / 402,
      ) < 1e-3,
    );
  });
});

describe("charging", () => {
  test("effective power is cable-limited (2 x 180 = 360 < 600)", () => {
    assert.equal(effectivePowerKw(1, site, vehicle), 180);
    assert.equal(effectivePowerKw(2, site, vehicle), 360);
    assert.equal(effectivePowerKw(3, site, vehicle), 360, "per-vehicle max cables");
  });
  test("10% → 100% on one cable: 558.9 kWh / 180 kW ≈ 186 min charging", () => {
    const c = chargeTime({ socFrom: 0.1, socTo: 1, cables: 1, site, vehicle });
    assert.ok(Math.abs(c.chargingMinutes - 186) <= 1, `${c.chargingMinutes}`);
    assert.equal(c.plugHandlingMinutes, 10);
    assert.equal(c.minutes, c.chargingMinutes + c.plugHandlingMinutes);
  });
  test("full recharge on two cables ≈ 93 min charging", () => {
    const c = chargeTime({ socFrom: 0.1, socTo: 1, cables: 2, site, vehicle });
    assert.ok(Math.abs(c.chargingMinutes - 93) <= 1, `${c.chargingMinutes}`);
  });
  test("nothing to charge", () => {
    assert.equal(
      chargeTime({ socFrom: 1, socTo: 1, cables: 2, site, vehicle }).minutes,
      0,
    );
  });
});

describe("drivers' hours", () => {
  const col = {
    depotDeparture: 420,
    outboundDeparture: 435,
    outboundArrival: 637,
    returnDeparture: 682,
    returnArrival: 882,
    depotArrival: 897,
  };
  test("proposed column C01 is legal with zero layover slack", () => {
    const r = checkColumn(col, rules);
    assert.equal(r.layoverMinutes, 45);
    assert.equal(r.layoverSlackMinutes, 0);
    assert.equal(r.outboundDrivingMinutes, 217);
    assert.equal(r.returnDrivingMinutes, 215);
    assert.equal(r.dailyDrivingMinutes, 432);
    assert.equal(r.dutyMinutes, 477);
    assert.equal(r.legal, true);
  });
  test("a 40-minute layover fails the break check", () => {
    const r = checkColumn({ ...col, returnDeparture: 677 }, rules);
    assert.equal(r.checks.layoverAtLeast45Min, false);
    assert.equal(r.legal, false);
  });
  test("a 4h40 outbound stint fails continuous driving", () => {
    const r = checkColumn({ ...col, outboundArrival: 435 + 265 }, rules); // 15 dead + 265 = 280 > 270
    assert.equal(r.checks.continuousDrivingWithin4h30, false);
  });
  test("a 6h10 outbound stint fails continuous working", () => {
    const r = checkColumn({ ...col, outboundArrival: 435 + 370 }, rules); // 15 dead + 370 = 385 > 360
    assert.equal(r.checks.continuousWorkingWithin6h, false);
    assert.equal(r.continuousWorkingMinutes, 385);
  });
  test("without depot legs, dead running is zero", () => {
    const r = checkColumn(
      {
        outboundDeparture: 435,
        outboundArrival: 637,
        returnDeparture: 682,
        returnArrival: 882,
      },
      rules,
    );
    assert.equal(r.outboundDrivingMinutes, 202);
    assert.equal(r.dutyMinutes, 447);
  });
});

describe("block scheduler", () => {
  const columns = Array.from({ length: 8 }, (_, i) => ({
    columnId: `C0${i + 1}`,
    depotDeparture: 420 + i * 120,
    depotArrival: 897 + i * 120,
  }));

  test("8 two-hourly ~8h columns need 5 vehicles when recharge takes ~1h45", () => {
    const r = scheduleBlocks({
      columns,
      energyPerReturnKwh: 402,
      vehicle,
      site,
      slotMinutes: 15,
    });
    assert.equal(r.vehiclesRequired, 5);
    assert.equal(r.unassignedColumns.length, 0);
    assert.deepEqual(
      r.vehicles.map((v) => v.columnIds.join("+")),
      ["C01+C06", "C02+C07", "C03+C08", "C04", "C05"],
    );
    assert.ok(r.cables.peak <= site.cables);
    assert.equal(r.cables.withinCapacity, true);
  });

  test("charging starts at the actual return time, not the slot boundary", () => {
    const r = scheduleBlocks({
      columns,
      energyPerReturnKwh: 402,
      vehicle,
      site,
      slotMinutes: 15,
    });
    const charge = r.vehicles[0].blocks.find((b) => b.type === "charge");
    assert.equal(charge.start, 897);
    assert.equal(charge.cables, 2);
    assert.ok(charge.end <= 420 + 5 * 120, "recharged before the C06 departure");
  });

  test("a return breaching the buffer still schedules when the trip fits the full pack", () => {
    const r = scheduleBlocks({ columns, energyPerReturnKwh: 564.1, vehicle, site });
    assert.equal(r.energy.returnFeasible, false);
    assert.equal(r.unassignedColumns.length, 0);
    assert.equal(r.vehiclesRequired, 5);
  });

  test("a return exceeding full pack capacity leaves every column unassigned", () => {
    const r = scheduleBlocks({ columns, energyPerReturnKwh: 676.9, vehicle, site });
    assert.equal(r.vehiclesRequired, 0);
    assert.equal(r.unassignedColumns.length, 8);
    assert.equal(r.energy.returnFeasible, false);
  });

  test("if charging were instant, 4 vehicles would suffice", () => {
    const fast = { ...site, cablePowerKw: 100000, plugHandlingMinutes: 0 };
    const bigVehicle = { ...vehicle, maxChargePowerKw: 100000 };
    const r = scheduleBlocks({
      columns,
      energyPerReturnKwh: 402,
      vehicle: bigVehicle,
      site: fast,
    });
    assert.equal(r.vehiclesRequired, 4);
  });

  test("cable contention with 4 vehicles returning together caps at 4 cables", () => {
    const together = Array.from({ length: 4 }, (_, i) => ({
      columnId: `X${i}`,
      depotDeparture: 420 + i,
      depotArrival: 900 + i,
    }));
    const r = scheduleBlocks({
      columns: together,
      energyPerReturnKwh: 402,
      vehicle,
      site,
    });
    assert.equal(r.cables.peak, 4);
    assert.equal(r.cables.withinCapacity, true);
  });
});
