// Zeichnungsebenen-Manager als EIGENES natives Tauri-Fenster — Referenz:
// DOSSIER-Rhino-Plugin (`git.kgva.ch/karim/DOSSIER`, `src/DrawingLevelsApp.jsx`
// + `rhino/layers_panel.py`), dort ein eigenständiges Rhino-Panel statt
// angedockt. Hier: dieselbe Liste wie das bestehende Dock-Panel
// (DrawingLevelsPanel.tsx), zusätzlich als Fenster öffenbar — das Dock-Panel
// bleibt bestehen (bewusst additiv, nicht ersetzt, anders als beim
// Ressourcen-Manager, der nie ein Dock-Panel war).
//
// Gleiches Sync-/Command-Prinzip wie settingsWindow.ts: ein expliziter, enger
// Zustand (nicht das ganze Project) + eine {name,args}-Command-RPC.
// **Bewusst NICHT unterstützt** (Scope-Entscheidung, s. PENDENZEN.md): das
// Rechtsklick-Kontextmenü einer Zeile (Duplizieren/Löschen/Einstellungen…) —
// das lebt heute als App-weites Overlay im HAUPTFENSTER; ein Klick im
// Zeichnungsebenen-FENSTER kann es dort nicht sinnvoll positionieren. Bis das
// eigens gelöst ist, bleibt Rechtsklick im Fenster ein No-op (Auswahl/
// Sichtbarkeit/Hinzufügen funktionieren voll).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useRef } from "react";
import { isTauriRuntime } from "../io/projectFile";
import type { DrawingLevel } from "../model/types";
import type { DisplayMode } from "../panels/types";
import { BORDERLESS_WINDOW_CHROME } from "./windowChrome";

const DRAWING_LEVELS_WINDOW_LABEL = "drawing-levels";

export interface DrawingLevelsSyncState {
  drawingLevels: DrawingLevel[];
  activeLevelId: string;
  displayMode: DisplayMode;
}

export interface DrawingLevelsCommandHandlers {
  onSelectLevel: (id: string) => void;
  onToggleLevel: (id: string) => void;
  onAddFloor: () => void;
  onAddSection: () => void;
  onAddElevation: () => void;
  onAddDrawing: () => void;
  onSetDisplayMode: (mode: DisplayMode) => void;
}

/** Öffnet das native Zeichnungsebenen-Fenster (bzw. holt es nach vorne). */
export async function openDrawingLevelsWindowNative(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(DRAWING_LEVELS_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(DRAWING_LEVELS_WINDOW_LABEL, {
    url: "index.html?window=drawing-levels",
    title: "Zeichnungsebenen — Dossier",
    width: 340,
    height: 560,
    minWidth: 260,
    minHeight: 300,
    ...BORDERLESS_WINDOW_CHROME,
  });
}

/** Hauptfenster-Seite der Sync-Brücke — Pendant zu useSettingsWindowHost. */
export function useDrawingLevelsWindowHost(
  state: DrawingLevelsSyncState,
  handlers: DrawingLevelsCommandHandlers,
): void {
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
      unlisten.push(
        await listen<{ name: string; args: unknown[] }>("drawing-levels-command", (e) => {
          const fn = (handlersRef.current as unknown as Record<string, unknown>)[e.payload.name];
          if (typeof fn === "function") (fn as (...a: unknown[]) => void)(...e.payload.args);
        }),
      );
      unlisten.push(
        await listen("drawing-levels-window-ready", () => {
          void emitTo(
            DRAWING_LEVELS_WINDOW_LABEL,
            "drawing-levels-sync-state",
            stateRef.current,
          ).catch(() => {});
        }),
      );
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void (async () => {
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo(DRAWING_LEVELS_WINDOW_LABEL, "drawing-levels-sync-state", state).catch(
        () => {},
      );
    })();
  }, [state]);
}
