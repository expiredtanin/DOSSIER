// Eigenständiger React-Root für das native Ressourcen-Fenster (siehe
// resourceWindow.ts für die Hauptfenster-Seite der Sync-Brücke). Von
// main.tsx gerendert, wenn die URL `?window=resources` trägt — KEIN Teil des
// normalen App-Baums (kein Zugriff auf den Haupt-Store, eigener Prozess).
//
// Projekt-Zustand kommt ausschliesslich per Tauri-Event vom Hauptfenster
// („resource-sync-project"); Bearbeitungen laufen NICHT lokal, sondern werden
// als „resource-command"-Events ans Hauptfenster geschickt, das die echten
// Handler aufruft und die Änderung über den nächsten Sync-Push zurückspiegelt
// — dasselbe Prinzip wie die native 2D/3D-Fensterspiegelung (nativeSync.ts),
// nur bidirektional statt nur lesend.
//
// Bezeichner englisch, UI-Text über i18n (CONVENTIONS.md).

import { useEffect, useMemo, useState } from "react";
import { ResourceManager } from "../ui/ResourceManager";
import type { ResourceManagerHandlers, TabId } from "../ui/ResourceManager";
import type { Project } from "../model/types";
import { t } from "../i18n";

/** Alle Felder von ResourceManagerHandlers sind Funktionen — für den Proxy unten. */
type HandlerName = keyof ResourceManagerHandlers;

/** Liest `?tab=…` aus der Fenster-URL (initialer Tab beim Öffnen aus einem Kontext). */
function initialTabFromUrl(): TabId | undefined {
  const v = new URLSearchParams(window.location.search).get("tab");
  return (v as TabId) || undefined;
}

/**
 * Eigenständige Seite des Ressourcen-Fensters. Zeigt einen Lade-Hinweis, bis
 * der erste Projekt-Sync vom Hauptfenster eintrifft (i. d. R. Millisekunden).
 */
export function ResourceWindowApp() {
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<TabId | undefined>(() => initialTabFromUrl());

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      unlisten.push(
        await listen<Project>("resource-sync-project", (e) => setProject(e.payload)),
      );
      unlisten.push(await listen<TabId>("resource-set-tab", (e) => setTab(e.payload)));
      // Hauptfenster um den aktuellen Stand bitten — deckt den Fall ab, dass
      // dieses Fenster NACH dem letzten Projekt-Push gestartet ist.
      await emitTo("main", "resource-window-ready").catch(() => {});
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  // Jeder Handler-Aufruf wird zu EINEM „resource-command"-Event ans
  // Hauptfenster (Name + Argumente, beides JSON-serialisierbar — alle
  // ResourceManagerHandlers-Signaturen sind reine Datenpatches). Per Proxy
  // statt 27 einzeln ausgeschriebenen Weiterleitungen (Drift-Gefahr).
  const handlers = useMemo<ResourceManagerHandlers>(
    () =>
      new Proxy({} as ResourceManagerHandlers, {
        get(_target, prop: string) {
          return (...args: unknown[]) => {
            void import("@tauri-apps/api/event").then(({ emitTo }) =>
              emitTo("main", "resource-command", { name: prop as HandlerName, args }).catch(
                (err) => console.error("[resource-window] emit resource-command failed", prop, err),
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

  if (!project) {
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
    <ResourceManager
      project={project}
      handlers={handlers}
      initialTab={tab}
      onClose={onClose}
      windowed
    />
  );
}
