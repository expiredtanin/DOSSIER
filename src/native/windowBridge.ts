// Gemeinsame Hauptfenster-Seite der Sync-Brücke zu den macOS-Nebenfenstern ([130]; vorher je Fenster kopiert).
//
// Hauptfenster → Nebenfenster: „<prefix>-sync-state" mit dem Zustand bei jeder Änderung und auf
//   „<prefix>-window-ready" (das Nebenfenster ist geladen und fragt nach).
// Nebenfenster → Hauptfenster: „<prefix>-command" mit { name, args } — `name` ist ein Schlüssel von `handlers`.
//
// No-op ausserhalb von Tauri. Das Ressourcen-Fenster (resourceWindow.ts) schickt Teil-Änderungen und bleibt eigen.

import { useEffect, useRef } from "react";
import { isTauriRuntime } from "./projectFile";

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
        void emitTo(label, `${prefix}-sync-state`, stateRef.current).catch(() => {});
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
    void (async () => {
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo(label, `${prefix}-sync-state`, stateRef.current).catch(() => {});
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` ersetzt `state`, wenn der Zustand je Render neu entsteht
  }, deps ?? [state]);
}
