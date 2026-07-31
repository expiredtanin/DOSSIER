// Standort-Import ("Standort importieren…", geo.admin/swisstopo/OSM) als
// EIGENES natives Tauri-Fenster statt Overlay-Dialog im Hauptfenster.
//
// Anders als Ressourcen/Einstellungen/Ebenen braucht dieser Dialog fast
// keinen geteilten Zustand: der gesamte Netz-Abruf (Geocoding, swissBUILDINGS3D/
// ALTI3D/SWISSIMAGE, OSM) läuft komplett INNERHALB von ContextImportDialog
// selbst (reine `io/*`-Funktionen, kein Store-Zugriff) — ein eigenes Fenster
// ist hier sogar naheliegender als beim Rest: ein langer Netz-Abruf blockiert
// so nicht einmal gedanklich das Hauptfenster. Nur das ENDERGEBNIS
// (fertige Kontext-Objekte + optionaler Georeferenzierungs-Bezug) muss zurück.
//
// Hauptfenster → Fenster: „context-import-sync-state" mit `{ geoAnchor }`.
// Fenster → Hauptfenster: „context-import-command" mit `{name,args}` — wie
// die übrigen Brücken (resourceWindow.ts etc.).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useRef } from "react";
import { isTauriRuntime } from "../io/projectFile";
import type { GeoAnchor } from "../ui/ContextImportDialog";
import { BORDERLESS_WINDOW_CHROME } from "./windowChrome";

const CONTEXT_IMPORT_WINDOW_LABEL = "context-import";

export interface ContextImportSyncState {
  geoAnchor: GeoAnchor | undefined;
}

export interface ContextImportCommandHandlers {
  onImport: (objs: unknown[]) => void;
  onSetGeoAnchor: (anchor: GeoAnchor | undefined) => void;
}

/** Öffnet das native Standort-Import-Fenster (bzw. holt es nach vorne). */
export async function openContextImportWindowNative(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(CONTEXT_IMPORT_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(CONTEXT_IMPORT_WINDOW_LABEL, {
    url: "index.html?window=context-import",
    title: "Standort importieren — dossier",
    width: 480,
    height: 680,
    minWidth: 400,
    minHeight: 480,
    ...BORDERLESS_WINDOW_CHROME,
  });
}

/** Hauptfenster-Seite der Sync-Brücke. */
export function useContextImportWindowHost(
  geoAnchor: GeoAnchor | undefined,
  handlers: ContextImportCommandHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const geoAnchorRef = useRef(geoAnchor);
  geoAnchorRef.current = geoAnchor;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      unlisten.push(
        await listen<{ name: string; args: unknown[] }>("context-import-command", (e) => {
          const fn = (handlersRef.current as unknown as Record<string, unknown>)[e.payload.name];
          if (typeof fn === "function") (fn as (...a: unknown[]) => void)(...e.payload.args);
        }),
      );
      unlisten.push(
        await listen("context-import-window-ready", () => {
          void emitTo(CONTEXT_IMPORT_WINDOW_LABEL, "context-import-sync-state", {
            geoAnchor: geoAnchorRef.current,
          }).catch(() => {});
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
      await emitTo(CONTEXT_IMPORT_WINDOW_LABEL, "context-import-sync-state", {
        geoAnchor,
      }).catch(() => {});
    })();
  }, [geoAnchor]);
}
