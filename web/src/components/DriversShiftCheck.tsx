/** @format */

import type { TimetableColumn } from "../types";
import { Badge, Check, DataTable, Panel, type Column } from "./ui";
import {
  CHECK_LABEL,
  continuousWorkingMinutes,
  dailyWorkingMinutes,
  DRIVER_CHECK_KEYS,
  driverCheckOk,
  driverLegal,
  MAX_CONTINUOUS_WORKING_MINUTES,
} from "../lib/derive";
import { duration } from "../lib/format";

function overLimitStyle(minutes: number, limit: number) {
  return minutes > limit ? { color: "var(--bad)", fontWeight: 600 as const } : undefined;
}

const columns: Column<TimetableColumn>[] = [
  { key: "id", header: "Driver", render: (c) => <b>{c.columnId}</b> },
  {
    key: "dd",
    header: "Depot dep",
    render: (c) => c.depotDeparture ?? c.outboundDeparture,
  },
  {
    key: "out",
    header: "Outbound driving",
    title: "Continuous driving, outbound leg incl. depot run",
    render: (c) => duration(c.driving?.outboundDrivingMinutes),
    num: true,
  },
  {
    key: "lay",
    header: "Layover (break)",
    render: (c) => (
      <span
        style={
          (c.layoverMinutes ?? 0) < 45
            ? { color: "var(--bad)", fontWeight: 600 }
            : undefined
        }
      >
        {duration(c.layoverMinutes)}
      </span>
    ),
    num: true,
  },
  {
    key: "slack",
    header: "Layover slack",
    title: "Layover minus the 45-min minimum break",
    render: (c) => duration(c.driving?.layoverSlackMinutes),
    num: true,
  },
  {
    key: "ret",
    header: "Return driving",
    render: (c) => duration(c.driving?.returnDrivingMinutes),
    num: true,
  },
  {
    key: "da",
    header: "Depot arr",
    render: (c) => c.depotArrival ?? c.returnArrival ?? "–",
  },
  {
    key: "daily",
    header: "Daily driving",
    render: (c) => duration(c.driving?.dailyDrivingMinutes),
    num: true,
  },
  {
    key: "cont-work",
    header: "Continuous working",
    title:
      "Longest working stint before the layover break · Road Transport (Working Time) Regulations 2005 · ≤ 6 h",
    render: (c) => {
      const m = continuousWorkingMinutes(c);
      if (m == null) return "–";
      return (
        <span style={overLimitStyle(m, MAX_CONTINUOUS_WORKING_MINUTES)}>
          {duration(m)}
        </span>
      );
    },
    num: true,
  },
  {
    key: "daily-work",
    header: "Daily working",
    title: "Depot dep → depot arr, incl. layover break",
    render: (c) => duration(dailyWorkingMinutes(c)),
    num: true,
  },
  ...DRIVER_CHECK_KEYS.map<Column<TimetableColumn>>((k) => ({
    key: k,
    header: CHECK_LABEL[k] ?? k,
    render: (c) => <Check ok={driverCheckOk(c, k)} />,
  })),
  {
    key: "res",
    header: "Result",
    render: (c) =>
      driverLegal(c) ? <Badge kind="ok">pass</Badge> : <Badge kind="bad">fail</Badge>,
  },
];

export default function DriversShiftCheck({ cols }: { cols: TimetableColumn[] }) {
  return (
    <Panel title="Drivers' shift check" sub="assimilated EU driving limits" tight>
      <DataTable rows={cols} columns={columns} rowKey={(c) => c.columnId} />
    </Panel>
  );
}
