// Einstellungen als EIGENES natives Tauri-Fenster (statt Overlay-Dialog im
// Hauptfenster) — Hauptfenster-Seite der Brücke. Gleiches Prinzip wie
// resourceWindow.ts, aber schmaler: SettingsDialog braucht nur eine Handvoll
// einzelner Felder (nicht das ganze Project), daher ein explizites
// Sync-/Command-Paar statt eines generischen Proxys über 27 Handler.
//
// Hauptfenster → Einstellungs-Fenster: „settings-sync-state" mit
//   { marqueeColor, snapColor, referenceElevationMasl, rendererMode,
//     webGpuAvailable, layout } bei jeder Änderung + auf „settings-window-ready".
// Einstellungs-Fenster → Hauptfenster: „settings-command" mit
//   { name, args } — dieselbe {name,args}-RPC-Form wie resource-command.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useRef } from "react";
import { isTauriRuntime } from "../io/projectFile";
import type { LayoutState } from "../panels/types";
import type { RendererMode } from "../ui/StatusBar";
import type { ThemeMode } from "../theme/themeMode";
import { BORDERLESS_WINDOW_CHROME } from "./windowChrome";

const SETTINGS_WINDOW_LABEL = "settings";

/** Alles, was SettingsDialog zum Rendern braucht — wandert 1:1 rüber. */
export interface SettingsSyncState {
  themeMode: ThemeMode;
  marqueeColor: string;
  snapColor: string;
  referenceElevationMasl: number | undefined;
  rendererMode: RendererMode;
  webGpuAvailable: boolean;
  layout: LayoutState;
}

/** Alle Aktionen, die das Einstellungs-Fenster auslösen kann. */
export interface SettingsCommandHandlers {
  onThemeModeChange: (mode: ThemeMode) => void;
  onMarqueeColorChange: (hex: string) => void;
  onSnapColorChange: (hex: string) => void;
  onReferenceElevationChange: (n: number | undefined) => void;
  onRendererModeChange: (mode: RendererMode) => void;
  onApplyLayout: (layout: LayoutState) => void;
}

/** Öffnet das native Einstellungs-Fenster (bzw. holt es nach vorne). */
export async function openSettingsWindowNative(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(SETTINGS_WINDOW_LABEL, {
    url: "index.html?window=settings",
    title: "Einstellungen — dossier",
    width: 520,
    height: 640,
    minWidth: 420,
    minHeight: 420,
    ...BORDERLESS_WINDOW_CHROME,
  });
}

/**
 * Hauptfenster-Seite der Sync-Brücke: hält das Einstellungs-Fenster (falls
 * offen) synchron zu `state` und wendet dessen Befehle auf `handlers` an.
 * No-op ausserhalb von Tauri.
 */
export function useSettingsWindowHost(
  state: SettingsSyncState,
  handlers: SettingsCommandHandlers,
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
        await listen<{ name: string; args: unknown[] }>("settings-command", (e) => {
          const fn = (handlersRef.current as unknown as Record<string, unknown>)[e.payload.name];
          if (typeof fn === "function") (fn as (...a: unknown[]) => void)(...e.payload.args);
        }),
      );
      unlisten.push(
        await listen("settings-window-ready", () => {
          void emitTo(SETTINGS_WINDOW_LABEL, "settings-sync-state", stateRef.current).catch(
            () => {},
          );
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
      await emitTo(SETTINGS_WINDOW_LABEL, "settings-sync-state", state).catch(() => {});
    })();
  }, [state]);
}
