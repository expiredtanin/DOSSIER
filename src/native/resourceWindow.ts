// Ressourcen-Manager als EIGENES natives Tauri-Fenster (statt schwebendes
// Overlay im Hauptfenster) — Hauptfenster-Seite der Brücke.
//
// Ein natives Zweitfenster ist ein separater Webview-Prozesskontext: KEIN
// gemeinsamer JS-Speicher, also kein direkter Store-Zugriff. Die Brücke
// synchronisiert daher explizit über Tauri-Events (@tauri-apps/api/event):
//   • Hauptfenster → Ressourcen-Fenster: „resource-sync-project" mit dem
//     kompletten (JSON-serialisierbaren) Project bei jeder Änderung + einmal
//     sofort, sobald das Ressourcen-Fenster „resource-window-ready" meldet
//     (Race-Schutz: das Fenster könnte später starten als der erste Push).
//   • Ressourcen-Fenster → Hauptfenster: „resource-command" mit
//     `{ name, args }` — der Name eines ResourceManagerHandlers-Feldes plus
//     seine Argumente. Das Hauptfenster ruft den ECHTEN Handler auf (der
//     Projekt-Patches über setProject anwendet); die Antwort kommt implizit
//     über den nächsten „resource-sync-project"-Push zurück.
// Das Gegenstück (Fenster-Seite: Proxy-Handlers + Projekt-State) lebt in
// ResourceWindowApp.tsx.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useRef } from "react";
import { isTauriRuntime } from "../io/projectFile";
import type { Project } from "../model/types";
import type { ResourceManagerHandlers, TabId } from "../ui/ResourceManager";
import { BORDERLESS_WINDOW_CHROME } from "./windowChrome";

/** Fenster-Label des Ressourcen-Fensters (für emitTo/getByLabel). */
const RESOURCE_WINDOW_LABEL = "resources";

/**
 * Öffnet das native Ressourcen-Fenster (bzw. holt es nach vorne, falls schon
 * offen). No-op-Fallback existiert NICHT hier — Aufrufer prüfen
 * `isTauriRuntime()` selbst und nutzen sonst das alte Overlay (App.tsx).
 */
export async function openResourceWindowNative(initialTab?: TabId): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(RESOURCE_WINDOW_LABEL);
  if (existing) {
    if (initialTab) {
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo(RESOURCE_WINDOW_LABEL, "resource-set-tab", initialTab).catch(() => {});
    }
    await existing.setFocus();
    return;
  }
  const url =
    "index.html?window=resources" + (initialTab ? `&tab=${encodeURIComponent(initialTab)}` : "");
  new WebviewWindow(RESOURCE_WINDOW_LABEL, {
    url,
    title: "Ressourcen — Dossier",
    width: 780,
    height: 660,
    minWidth: 480,
    minHeight: 360,
    ...BORDERLESS_WINDOW_CHROME,
  });
}

/**
 * Hauptfenster-Seite der Sync-Brücke: hält das Ressourcen-Fenster (falls
 * offen) mit dem aktuellen Projekt synchron und wendet dessen Befehle auf die
 * ECHTEN Handler an. No-op ausserhalb von Tauri. In App.tsx neben der
 * bestehenden `<ResourceManager>`-Einbettung aufrufen (dieselben
 * `resourceHandlers`).
 */
export function useResourceWindowHost(
  project: Project,
  handlers: ResourceManagerHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const projectRef = useRef(project);
  projectRef.current = project;

  // Befehle vom Ressourcen-Fenster entgegennehmen + auf die echten Handler
  // anwenden, UND bei „ready" (Fenster gerade erst gestartet) sofort das
  // aktuelle Projekt nachschieben.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      unlisten.push(
        await listen<{ name: string; args: unknown[] }>("resource-command", (e) => {
          const fn = (handlersRef.current as unknown as Record<string, unknown>)[e.payload.name];
          if (typeof fn === "function") {
            (fn as (...a: unknown[]) => void)(...e.payload.args);
          } else {
            console.error("[resource-window-host] unknown resource-command", e.payload.name);
          }
        }),
      );
      unlisten.push(
        await listen("resource-window-ready", () => {
          void emitTo(RESOURCE_WINDOW_LABEL, "resource-sync-project", projectRef.current).catch(
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

  // Bei jeder Projektänderung ans (evtl. offene) Ressourcen-Fenster pushen.
  // `emitTo` auf ein nicht existierendes Fenster ist harmlos (kein Empfänger).
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void (async () => {
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo(RESOURCE_WINDOW_LABEL, "resource-sync-project", project).catch(() => {});
    })();
  }, [project]);
}
