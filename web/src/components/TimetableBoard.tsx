/** @format */

import type { TimetableBoardGroupedModel } from "../lib/timetable-board";

export function TimetableGroupedGrid({ board }: { board: TimetableBoardGroupedModel }) {
  const columns = board.groups.flatMap((g) =>
    g.journeys.map((j) => ({ ...j, key: `${g.id}-${j.id}`, groupId: g.id })),
  );
  if (!columns.length) return null;

  return (
    <div className="timetable-board-block">
      <h4 className="timetable-board-direction">{board.heading}</h4>
      <div className="table-wrap timetable-board-wrap">
        <table className="data timetable-board">
          <thead>
            <tr>
              <th className="timetable-board-stop" rowSpan={2}>
                Stop
              </th>
              {board.groups.map((g) => (
                <th
                  key={g.id}
                  colSpan={g.journeys.length}
                  className="timetable-board-group group-header"
                >
                  {g.label}
                </th>
              ))}
            </tr>
            <tr>
              {board.groups.flatMap((g) =>
                g.journeys.map((j) => (
                  <th key={`${g.id}-${j.id}`} className="num timetable-board-trip">
                    {j.id}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {board.stops.map((stop, rowIdx) => (
              <tr key={`${stop}-${rowIdx}`}>
                <td className="timetable-board-stop">{stop}</td>
                {columns.map((j) => (
                  <td key={j.key} className="num timetable-board-time">
                    {j.times[rowIdx] ?? "–"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

