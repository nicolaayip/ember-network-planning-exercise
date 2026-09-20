# Dashboard

Reviewer quick start: see [`../README.md`](../README.md). This app needs no API keys — scenario JSON is committed.

Read-only viewer over the engine's outputs. Static Vite + React app: no server,
no API keys, no live external calls. One scenario per engine output JSON, switchable in the top bar.

## Run

```bash
# from the repo root, after an engine run has written output/<routeId>.json
cd web
npm install
npm run sync      # copies ../output/*.json → public/scenarios/ and writes index.json
npm run dev       # http://localhost:5173
```

`npm run sync -- --label newcastle-edinburgh="Proposed timetable"` overrides a scenario label
(default is `routeName — mode`). Scenario files are committed so the deployed site is self-contained.

## Views

| View | Evidence map row | Reads |
| --- | --- | --- |
| Route & stops | Q1 | `directions.*.orderedStops` (catchment, deviation, recommendation), `routePolyline` |
| Stop pairs | Q1 | `directions.*.directionalODPairs` (path detour, competition, headway gaps) |
| Running times | Q2 driving times | `trafficProfile`, `estimatedTemporalWindows`, `directions.*.legs` (WebTRIS windows, Google timing, coach factor, proposed, delta) |
| Timetable audit | Q2 services | `timetableColumns`, `timetableSelection` (slot ranking, fleet cap) |
| Fleet & charging | Q3 | `fleet.energy`, `fleet.charging`; Gantt recomputed client-side from `timetableColumns` + `fleet.scenarios.*.grid.slotMinutes` |
| Methodology | — | Route, Timetable, and Fleet method notes with values from `assumptions[]` and the document |

Every field is optional beyond the schema's required core; panels show an explanatory placeholder
when a phase has not populated its data yet.

## Build for static hosting

```bash
cd web && npm run build
```

Upload `dist/` to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages). Scenario JSON is already in `public/scenarios/` — no server or API keys at runtime.
