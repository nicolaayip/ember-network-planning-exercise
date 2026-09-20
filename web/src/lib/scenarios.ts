import { useEffect, useState } from "react";
import type { EngineDocument, ReferencePin, ReferencePins, ScenarioMeta } from "../types";

const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

export async function loadIndex(): Promise<ScenarioMeta[]> {
  const res = await fetch(`${base}scenarios/index.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`scenarios/index.json: HTTP ${res.status}`);
  return res.json();
}

export async function loadScenario(meta: ScenarioMeta): Promise<EngineDocument> {
  const res = await fetch(`${base}${meta.file}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${meta.file}: HTTP ${res.status}`);
  return res.json();
}

export async function loadPins(meta: ScenarioMeta): Promise<ReferencePin[]> {
  if (!meta.pins) return [];
  const res = await fetch(`${base}${meta.pins}`, { cache: "no-cache" });
  if (!res.ok) return [];
  const body = (await res.json()) as ReferencePins;
  return body.pins ?? [];
}

export type LoadState<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; value: T };

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fn().then(
      (value) => live && setState({ status: "ready", value }),
      (err) => live && setState({ status: "error", error: err instanceof Error ? err.message : String(err) })
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
