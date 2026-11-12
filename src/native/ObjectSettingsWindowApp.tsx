// [195b] Eigenständiger Root des nativen Fensters „Objekteinstellungen" (`?window=object-settings`, von main.tsx
// gerendert; Hauptfenster-Seite: `objectSettingsWindow.ts`, Protokoll: `objectSettingsSync.ts`).
//
// Keine zweite Implementierung der Abschnitte: das Fenster rendert `ObjectSettingsPanel` wie das schwebende Panel.
// Der Store dieses Dokuments ist ein Spiegel des Hauptfensters (Projekt + Kern-Dokument, Auswahl, aktive Ebene);
// seine Projekt-Änderungen gehen als Ops ans Hauptfenster (`changeSink.ts`), Host-Handler ebenso. Cmd+Z/
// Cmd+Shift+Z wirken auf den Verlauf des Hauptfensters; Esc schliesst das Fenster.

import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import { PanelHostProvider } from "../panels/host";
import type { PanelHost } from "../panels/types";
import { ObjectSettingsPanel } from "../panels/objectSettings/ObjectSettingsPanel";
import { setSettingsArea } from "../panels/objectSettings/areaState";
import { expandAndFocusInfoGroup } from "../panels/objectInfo/infoGroupState";
import { setState } from "../state/appStore";
import { setChangeSink } from "../state/changeSink";
import {
  OBJECT_SETTINGS_PREFIX as PREFIX,
  applyObjectSettingsSync,
  mirrorIntoStore,
  remoteHost,
  type ObjectSettingsSnapshot,
  type ObjectSettingsSync,
  type ObjectSettingsUi,
} from "./objectSettingsSync";

/** Befehl ans Hauptfenster (s. Protokoll in `objectSettingsSync.ts`). */
function send(name: string, args: unknown[] = []): void {
  void import("@tauri-apps/api/event").then(({ emitTo }) =>
    emitTo("main", `${PREFIX}-command`, { name, args }).catch((err) => console.error("[object-settings] Befehl nicht gesendet", name, err)),
  );
}

const isTextEntry = (el: Element | null): boolean =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

export function ObjectSettingsWindowApp() {
  const [ui, setUi] = useState<ObjectSettingsUi | null>(null);

  useEffect(() => {
    // Änderungen nicht lokal anwenden, sondern ans Hauptfenster (das hält Verlauf und Wahrheit).
    setChangeSink((ops, key) => send("change", [ops, key ?? null]));
    setState({ notify: (message: string, kind?: "info" | "warning" | "error") => send("notify", [message, kind ?? "info"]) });

    let disposed = false;
    let snap: ObjectSettingsSnapshot | null = null;
    let focusSeq = 0;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      const off = await listen<ObjectSettingsSync>(`${PREFIX}-sync`, (e) => {
        const next = applyObjectSettingsSync(snap, e.payload);
        if (!next) return;
        mirrorIntoStore(snap, next);
        snap = next;
        const f = next.ui.focus;
        if (f && f.seq !== focusSeq) {
          focusSeq = f.seq;
          setSettingsArea("object");
          if (f.group) expandAndFocusInfoGroup(f.group);
        }
        setUi(next.ui);
      });
      if (disposed) return off();
      unlisten.push(off);
      await emitTo("main", `${PREFIX}-window-ready`).catch(() => {});
    })();

    const onKey = (e: KeyboardEvent) => {
      if (isTextEntry(document.activeElement)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        send(e.shiftKey ? "redo" : "undo");
      } else if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        send("redo");
      } else if (e.key === "Escape") {
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      unlisten.forEach((u) => u());
      setChangeSink(null);
    };
  }, []);

  const hostData = ui?.host;
  const handlers = ui?.handlers;
  const host = useMemo(
    () => (hostData && handlers ? (remoteHost({ host: hostData, handlers }, (name, args) => send("host", [name, args])) as unknown as PanelHost) : null),
    [hostData, handlers],
  );

  return (
    <div className="objset-window">
      <header className="imp-head" data-tauri-drag-region style={{ paddingLeft: 88 }}>
        <span className="imp-head-title">{t("nav.objectSettings")}</span>
      </header>
      {host ? (
        <PanelHostProvider value={host}>
          <ObjectSettingsPanel />
        </PanelHostProvider>
      ) : (
        <div className="objset-empty">{t("resources.loading")}</div>
      )}
    </div>
  );
}
