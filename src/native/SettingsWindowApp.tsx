// Eigenständiger React-Root für das native Einstellungs-Fenster (siehe
// settingsWindow.ts für die Hauptfenster-Seite der Sync-Brücke). Von
// main.tsx gerendert, wenn die URL `?window=settings` trägt. Gleiches Prinzip
// wie ResourceWindowApp.tsx, nur mit dem schmaleren Settings-Zustand statt
// des ganzen Projekts.
//
// Bezeichner englisch, UI-Text über i18n (CONVENTIONS.md).

import { useEffect, useMemo, useState } from "react";
import { SettingsDialog } from "../ui/SettingsDialog";
import type { SettingsCommandHandlers, SettingsSyncState } from "./settingsWindow";
import { t } from "../i18n";
import { applyThemeMode } from "../theme/themeMode";

type HandlerName = keyof SettingsCommandHandlers;

export function SettingsWindowApp() {
  const [state, setState] = useState<SettingsSyncState | null>(null);

  // Dieses Fenster ist ein eigenes Dokument — Hell/Dunkel muss hier separat
  // angewendet werden, sobald der synchronisierte Zustand eintrifft.
  useEffect(() => {
    if (state) applyThemeMode(state.themeMode);
  }, [state]);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      unlisten.push(
        await listen<SettingsSyncState>("settings-sync-state", (e) => setState(e.payload)),
      );
      // Hauptfenster um den aktuellen Stand bitten (Race-Schutz: dieses
      // Fenster könnte nach dem letzten Sync-Push gestartet sein).
      await emitTo("main", "settings-window-ready").catch(() => {});
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  // Jeder Handler-Aufruf → EIN „settings-command"-Event ans Hauptfenster
  // (Name + Argumente), analog ResourceWindowApp.tsx.
  const handlers = useMemo<SettingsCommandHandlers>(
    () =>
      new Proxy({} as SettingsCommandHandlers, {
        get(_target, prop: string) {
          return (...args: unknown[]) => {
            void import("@tauri-apps/api/event").then(({ emitTo }) =>
              emitTo("main", "settings-command", { name: prop as HandlerName, args }).catch(
                () => {},
              ),
            );
          };
        },
      }),
    [],
  );

  const onClose = () => {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow().close(),
    );
  };

  if (!state) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "var(--ink-dim, #8a8a8a)",
          fontSize: 13,
        }}
      >
        {t("resources.loading")}
      </div>
    );
  }

  return (
    <SettingsDialog
      themeMode={state.themeMode}
      onThemeModeChange={handlers.onThemeModeChange}
      marqueeColor={state.marqueeColor}
      onMarqueeColorChange={handlers.onMarqueeColorChange}
      snapColor={state.snapColor}
      onSnapColorChange={handlers.onSnapColorChange}
      referenceElevationMasl={state.referenceElevationMasl}
      onReferenceElevationChange={handlers.onReferenceElevationChange}
      scaleLineWeights={state.scaleLineWeights}
      onScaleLineWeightsChange={handlers.onScaleLineWeightsChange}
      offline={state.offline}
      onOfflineChange={handlers.onOfflineChange}
      aiAccess={state.aiAccess}
      onAiAccessChange={handlers.onAiAccessChange}
      layout={state.layout}
      onApplyLayout={handlers.onApplyLayout}
      onClose={onClose}
      windowed
    />
  );
}
