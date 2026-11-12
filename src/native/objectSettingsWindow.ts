// [195b] Fenster „Objekteinstellungen" (Taste T) als EIGENES natives Tauri-Fenster wie Einstellungen/Ressourcen —
// Hauptfenster-Seite der Brücke. Protokoll und reine Teile: `objectSettingsSync.ts`; Fensterseite:
// `ObjectSettingsWindowApp.tsx`. Im Browser/Electron bleibt das schwebende Panel (`state/objectSettings.ts`).
//
// Der Spiegel wird nur gesendet, solange das Fenster offen ist (es meldet „ready"; zu = `getByLabel` leer), kurz
// gebündelt, und ohne React-Abo im Hauptfenster: der Hook hört direkt am Store, eine Op rendert die App nicht neu.

import { useEffect, useRef } from "react";
import { getState, subscribe } from "../state/appStore";
import { storeDocument } from "../state/historySlice";
import { t } from "../i18n";
import type { NotifyKind } from "../state/notifySlice";
import type { InfoGroupId } from "../panels/objectInfo/groups";
import type { CoreOp } from "../core/ops";
import { isTauriRuntime } from "./projectFile";
import { BORDERLESS_WINDOW_CHROME } from "./windowChrome";
import {
  OBJECT_SETTINGS_PREFIX as PREFIX,
  OBJECT_SETTINGS_WINDOW_LABEL as LABEL,
  ObjectSettingsSender,
  applyForwardedChange,
  hostSnapshot,
  type ObjectSettingsSnapshot,
} from "./objectSettingsSync";

let focus: ObjectSettingsSnapshot["ui"]["focus"] = null;
const focusListeners = new Set<() => void>();

/**
 * Öffnet das Fenster (bzw. holt es nach vorne) und bittet es, den Bereich „Objekt" zu zeigen und `group`
 * aufzuklappen (Taste T, `state/objectSettings.ts`).
 */
export async function openObjectSettingsWindowNative(group: InfoGroupId | null): Promise<void> {
  focus = { seq: (focus?.seq ?? 0) + 1, group };
  for (const l of [...focusListeners]) l();
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow(LABEL, {
    url: "index.html?window=object-settings",
    title: `${t("nav.objectSettings")} — dossier`,
    width: 380,
    height: 620,
    minWidth: 300,
    minHeight: 320,
    ...BORDERLESS_WINDOW_CHROME,
  });
}

/** Bündelung der Sync-Nachrichten (ms): Tippen/Ziehen schickt nicht jeden Zwischenstand einzeln. */
const SYNC_DELAY_MS = 30;

/**
 * Hält das Fenster (falls offen) synchron zu Projekt, Auswahl, aktiver Ebene und den Wert-Feldern von `host`
 * (Panel-Host der App) und führt seine Befehle aus: Ops per `applyChange`, Host-Handler auf `host`. No-op
 * ausserhalb von Tauri.
 */
export function useObjectSettingsWindowHost(host: object): void {
  const hostRef = useRef(host);
  hostRef.current = host;
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let open = false;
    // Baut die Nachrichten; sammelt dafür die angenommenen Ops des Kern-Dokuments (Ops-Strom statt Neuladen).
    const sender = new ObjectSettingsSender();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlisten: Array<() => void> = [];

    const current = (): ObjectSettingsSnapshot => {
      const s = getState();
      return { project: s.project, ui: { selection: s.selection, activeLevelId: s.activeLevelId, ...hostSnapshot(hostRef.current), focus } };
    };
    const flush = async () => {
      timer = null;
      if (disposed || !open) return;
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      if (!(await WebviewWindow.getByLabel(LABEL))) {
        // Fenster zu: beim nächsten Öffnen meldet es „ready" und bekommt den ganzen Stand.
        open = false;
        sender.reset();
        return;
      }
      const msg = sender.next(current());
      if (!msg) return;
      const { emitTo } = await import("@tauri-apps/api/event");
      // Fehlgeschlagen: das Fenster merkt die Lücke an `seq`; der nächste Sync ist ohnehin der ganze Stand.
      await emitTo(LABEL, `${PREFIX}-sync`, msg).catch(() => sender.reset());
    };
    const schedule = () => {
      if (!open || timer !== null) return;
      timer = setTimeout(() => void flush(), SYNC_DELAY_MS);
    };
    scheduleRef.current = schedule;

    // Store-Änderungen: nur Projekt, Auswahl, aktive Ebene zählen (der Rest ändert sich oft und interessiert nicht).
    let last = getState();
    unlisten.push(
      subscribe(() => {
        const s = getState();
        if (s.project !== last.project || s.selection !== last.selection || s.activeLevelId !== last.activeLevelId) schedule();
        last = s;
      }),
    );
    unlisten.push(storeDocument(getState().project).onChange((before, after, ops) => sender.record(before, after, ops)));
    focusListeners.add(schedule);
    unlisten.push(() => focusListeners.delete(schedule));

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (disposed) return;
      const offReady = await listen(`${PREFIX}-window-ready`, () => {
        open = true;
        sender.reset();
        void flush();
      });
      const offCommand = await listen<{ name: string; args?: unknown[] }>(`${PREFIX}-command`, (e) => {
        const args = e.payload.args ?? [];
        switch (e.payload.name) {
          case "change":
            applyForwardedChange(args[0] as CoreOp[], args[1] as string | null);
            break;
          case "host": {
            const fn = (hostRef.current as Record<string, unknown>)[args[0] as string];
            if (typeof fn === "function") (fn as (...a: unknown[]) => void)(...((args[1] as unknown[]) ?? []));
            break;
          }
          case "undo":
            getState().undo();
            break;
          case "redo":
            getState().redo();
            break;
          case "notify":
            getState().notify(String(args[0] ?? ""), (args[1] as NotifyKind | undefined) ?? "info");
            break;
        }
      });
      if (disposed) {
        offReady();
        offCommand();
        return;
      }
      unlisten.push(offReady, offCommand);
    })();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      unlisten.forEach((u) => u());
      scheduleRef.current = () => {};
    };
  }, []);

  // Host-Werte (aktives Werkzeug, Schnittlinie …) ändern sich mit dem Host.
  useEffect(() => scheduleRef.current(), [host]);
}
