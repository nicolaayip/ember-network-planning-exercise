/** @format */

import { useEffect, useMemo, useState } from "react";
import type { DirectionName, EngineDocument, ReferencePin, ScenarioMeta } from "./types";
import { loadIndex, loadPins, loadScenario, useAsync } from "./lib/scenarios";
import { Seg } from "./components/ui";
import RouteStops from "./views/RouteStops";
import Legs from "./views/Legs";
import ODPairs from "./views/ODPairs";
import Timetable from "./views/Timetable";
import FleetView from "./views/Fleet";
import Methodology from "./views/Methodology";

const VIEWS = [
  { id: "route", label: "Route & stops", group: "Route" },
  { id: "pairs", label: "Stop pairs", group: "Route" },
  { id: "legs", label: "Running times", group: "Timetable" },
  { id: "timetable", label: "Timetable audit", group: "Timetable" },
  { id: "fleet", label: "Fleet & charging", group: "Fleet" },
  { id: "methodology", label: "Methodology", group: "Model" },
] as const;

function isModelView(view: ViewId): view is "methodology" {
  return view === "methodology";
}
const GROUPS = Array.from(new Set(VIEWS.map((v) => v.group)));
type ViewId = (typeof VIEWS)[number]["id"];

export interface ViewProps {
  doc: EngineDocument;
  pins: ReferencePin[];
  direction: DirectionName;
  setDirection: (d: DirectionName) => void;
}

function readHash(): { view: ViewId; scenario?: string } {
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const raw = h.get("view");
  const v =
    raw === "peaks" || raw === "traffic"
      ? "legs"
      : raw === "assumptions"
        ? "methodology"
        : raw === "drivers"
          ? "fleet"
          : raw === "overview"
            ? "route"
            : (raw as ViewId | null);
  return {
    view: VIEWS.some((x) => x.id === v) ? (v as ViewId) : "route",
    scenario: h.get("s") ?? undefined,
  };
}

export default function App() {
  const index = useAsync(loadIndex, []);
  const [{ view, scenario: hashScenario }, setRoute] = useState(readHash);
  const [scenarioId, setScenarioId] = useState<string | undefined>(hashScenario);
  const [direction, setDirection] = useState<DirectionName>("outbound");

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const metas = index.status === "ready" ? index.value : [];
  const meta: ScenarioMeta | undefined = useMemo(
    () => metas.find((m) => m.id === scenarioId) ?? metas[0],
    [metas, scenarioId],
  );

  useEffect(() => {
    if (meta) {
      const h = new URLSearchParams({ view, s: meta.id });
      history.replaceState(null, "", `#${h}`);
    }
  }, [view, meta]);

  const doc = useAsync(
    () => (meta ? loadScenario(meta) : Promise.reject(new Error("no scenarios"))),
    [meta?.file],
  );
  const pins = useAsync(
    () => (meta ? loadPins(meta) : Promise.resolve([] as ReferencePin[])),
    [meta?.pins],
  );

  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];
  const go = (v: ViewId) => setRoute((r) => ({ ...r, view: v }));

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Ember</span>
          <span className="brand-sub">route evidence</span>
        </div>
        <nav className="nav">
          {GROUPS.map((g) => (
            <div key={g} className="nav-group">
              <div className="nav-group-label">{g}</div>
              {VIEWS.filter((v) => v.group === g).map((v) => (
                <button
                  key={v.id}
                  className={`nav-item ${v.id === view ? "active" : ""}`}
                  onClick={() => go(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        {(metas.length > 0 || doc.status === "ready") && (
          <div className="sidebar-foot">
            {metas.length > 0 ? (
              <label className="control">
                <span className="control-label">Scenario</span>
                <select value={meta?.id} onChange={(e) => setScenarioId(e.target.value)}>
                  {metas.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : doc.status === "ready" ? (
              <div className="small muted">{doc.value.routeName}</div>
            ) : null}
          </div>
        )}
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="crumbs">
            <span className="crumb muted">{current.group}</span>
            <span className="crumb-sep muted">/</span>
            <span className="crumb">{current.label}</span>
          </div>
          <div className="spacer" />
          <div className="topbar-filters">
            <Seg
              value={direction}
              onChange={setDirection}
              disabled={view === "fleet" || isModelView(view)}
              title={
                view === "fleet" || isModelView(view)
                  ? "Direction filter not used on this view"
                  : undefined
              }
              options={[
                { value: "outbound", label: "Outbound", swatch: "var(--outbound)" },
                { value: "return", label: "Return", swatch: "var(--return)" },
              ]}
            />
          </div>
        </header>

        <main className="main">
          {index.status === "error" && (
            <div className="error">
              Could not load <code>scenarios/index.json</code>: {index.error}. Run{" "}
              <code>npm run sync</code> in <code>web/</code> after an engine run.
            </div>
          )}
          {index.status === "ready" && metas.length === 0 && (
            <div className="error">
              No scenarios published. Run the engine, then <code>npm run sync</code> in{" "}
              <code>web/</code>.
            </div>
          )}
          {doc.status === "error" && (
            <div className="error">Could not load scenario: {doc.error}</div>
          )}
          {doc.status === "loading" && index.status !== "error" && (
            <p className="muted">Loading…</p>
          )}
          {doc.status === "ready" &&
            (() => {
              const props: ViewProps = {
                doc: doc.value,
                pins: pins.status === "ready" ? pins.value : [],
                direction,
                setDirection,
              };
              const body = (() => {
                switch (view) {
                  case "route":
                    return <RouteStops {...props} />;
                  case "legs":
                    return <Legs {...props} />;
                  case "pairs":
                    return <ODPairs {...props} />;
                  case "timetable":
                    return <Timetable {...props} />;
                  case "fleet":
                    return <FleetView {...props} />;
                  case "methodology":
                    return <Methodology {...props} />;
                }
              })();
              return body;
            })()}
        </main>
      </div>
    </div>
  );
}
