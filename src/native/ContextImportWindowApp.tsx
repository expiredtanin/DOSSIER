// Eigenständiger React-Root für das native Standort-Import-Fenster (siehe
// contextImportWindow.ts für die Hauptfenster-Seite der Sync-Brücke). Von
// main.tsx gerendert, wenn die URL `?window=context-import` trägt.
//
// Rendert `ContextImportDialog` UNVERÄNDERT (windowed=true) — der Dialog
// selbst braucht keinerlei Host-/Store-Zugriff (reine `io/*`-Netzabrufe),
// daher hier kein Proxy-Pattern nötig wie bei den anderen Fenstern: nur
// `onImport`/`onSetGeoAnchor` laufen als einzelne Events ans Hauptfenster.
//
// Bezeichner englisch, UI-Text über i18n (CONVENTIONS.md).

import { useEffect, useState } from "react";
import { ContextImportDialog } from "../ui/ContextImportDialog";
import type { GeoAnchor } from "../ui/ContextImportDialog";
import type { ContextImportSyncState } from "./contextImportWindow";
import { t } from "../i18n";

export function ContextImportWindowApp() {
  const [state, setState] = useState<ContextImportSyncState | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      unlisten.push(
        await listen<ContextImportSyncState>("context-import-sync-state", (e) =>
          setState(e.payload),
        ),
      );
      await emitTo("main", "context-import-window-ready").catch(() => {});
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  const send = (name: string, ...args: unknown[]) => {
    void import("@tauri-apps/api/event").then(({ emitTo }) =>
      emitTo("main", "context-import-command", { name, args }).catch(() => {}),
    );
  };

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
    <ContextImportDialog
      onImport={(objs) => send("onImport", objs)}
      onClose={onClose}
      geoAnchor={state.geoAnchor}
      onSetGeoAnchor={(anchor: GeoAnchor | undefined) => send("onSetGeoAnchor", anchor)}
      windowed
    />
  );
}
