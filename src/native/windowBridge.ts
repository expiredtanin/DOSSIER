// Gemeinsame Hauptfenster-Seite der Sync-Brücke zu den macOS-Nebenfenstern ([130]; vorher je Fenster kopiert).
//
// Hauptfenster → Nebenfenster: „<prefix>-sync-state" mit dem ganzen Zustand auf „<prefix>-window-ready"
//   (das Nebenfenster ist geladen und fragt nach); danach bei jeder Änderung nur „<prefix>-sync-patch"
//   mit den inhaltlich geänderten Feldern der obersten Ebene (`StateDelta`, [121]). Inhaltlich gleicher
//   Zustand (bei jedem Render neu abgeleitet) wird gar nicht gesendet. Nebenfenster wenden den Patch
//   mit `applyStateDelta` an (oder hören über `listenBridgeState` auf beides).
// Nebenfenster → Hauptfenster: „<prefix>-command" mit { name, args } — `name` ist ein Schlüssel von `handlers`.
//
// No-op ausserhalb von Tauri. Das Ressourcen-Fenster (resourceWindow.ts) schickt Teil-Änderungen und bleibt eigen.

import { useEffect, useRef } from "react";
import { isTauriRuntime } from "./projectFile";
import { dataEqual } from "../state/dataEqual";

/** Geänderte Felder eines Fenster-Zustands (oberste Ebene). */
export interface StateDelta {
  /** Geänderte oder neue Felder (ganze Werte). */
  set: Record<string, unknown>;
  /** Entfernte bzw. auf `undefined` gesetzte Felder (`undefined` übersteht JSON nicht). */
  unset: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Differenz zweier Fenster-Zustände (Strukturvergleich je Feld). `null` = inhaltlich gleich; `"full"` =
 * kein Patch möglich (einer der Zustände ist kein Objekt, z. B. `null`), ganz senden.
 */
export function stateDelta(prev: unknown, next: unknown): StateDelta | null | "full" {
  if (!isRecord(prev) || !isRecord(next)) return dataEqual(prev, next) ? null : "full";
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const k of Object.keys(next)) {
    if (next[k] === undefined) continue;
    if (!dataEqual(prev[k], next[k])) set[k] = next[k];
  }
  for (const k of Object.keys(prev)) {
    if (prev[k] !== undefined && next[k] === undefined) unset.push(k);
  }
  return Object.keys(set).length === 0 && unset.length === 0 ? null : { set, unset };
}

/** Wendet einen Patch an (neues Objekt; `base` bleibt unverändert). */
export function applyStateDelta<S>(base: S, delta: StateDelta): S {
  const out = { ...(base as Record<string, unknown>), ...delta.set };
  for (const k of delta.unset) delete out[k];
  return out as S;
}

/**
 * Nebenfenster-Seite: hört auf den ganzen Zustand und auf Patches; ein Patch vor dem ersten ganzen
 * Zustand wird verworfen (der kommt nach „ready"). Liefert die Abmelde-Funktionen.
 */
export async function listenBridgeState<S>(
  prefix: string,
  setState: (update: (prev: S | null) => S | null) => void,
): Promise<Array<() => void>> {
  const { listen } = await import("@tauri-apps/api/event");
  return [
    await listen<S>(`${prefix}-sync-state`, (e) => setState(() => e.payload)),
    await listen<StateDelta>(`${prefix}-sync-patch`, (e) =>
      setState((prev) => (prev === null ? prev : applyStateDelta(prev, e.payload))),
    ),
  ];
}

/** Befehle eines Nebenfensters: Name → Funktion (Argumente kommen unverändert aus dem Fenster). */
export type WindowHandlers = { [name: string]: (...args: never[]) => void };

/**
 * Hält das Nebenfenster `label` (falls offen) synchron zu `state` und wendet dessen Befehle auf `handlers` an.
 * `state` wird bei jeder neuen Identität gesendet; wer ihn bei jedem Render neu ableitet, übergibt `deps`.
 */
export function useWindowBridgeHost<S>(label: string, prefix: string, state: S, handlers: WindowHandlers, deps?: readonly unknown[]): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Was das Fenster zuletzt bekommen hat (Basis des nächsten Patches); `undefined` = noch nichts.
  const sentRef = useRef<{ state: S } | undefined>(undefined);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      const offCommand = await listen<{ name: string; args: unknown[] }>(`${prefix}-command`, (e) => {
        const fn = handlersRef.current[e.payload.name] as ((...a: unknown[]) => void) | undefined;
        if (typeof fn === "function") fn(...(e.payload.args ?? []));
      });
      const offReady = await listen(`${prefix}-window-ready`, () => {
        sentRef.current = { state: stateRef.current };
        void emitTo(label, `${prefix}-sync-state`, stateRef.current).catch(() => {
          sentRef.current = undefined;
        });
      });
      if (disposed) {
        offCommand();
        offReady();
        return;
      }
      unlisten.push(offCommand, offReady);
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, [label, prefix]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const next = stateRef.current;
    const prev = sentRef.current;
    const delta = prev ? stateDelta(prev.state, next) : "full";
    if (delta === null) return;
    sentRef.current = { state: next };
    const onFail = () => {
      sentRef.current = undefined;
    };
    void (async () => {
      const { emitTo } = await import("@tauri-apps/api/event");
      if (delta === "full") await emitTo(label, `${prefix}-sync-state`, next).catch(onFail);
      else await emitTo(label, `${prefix}-sync-patch`, delta).catch(onFail);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` ersetzt `state`, wenn der Zustand je Render neu entsteht
  }, deps ?? [state]);
}
