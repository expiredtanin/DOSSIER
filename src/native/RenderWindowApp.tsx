// [277] Eigenständiger React-Root für das native Rendering-Fenster (siehe renderWindow.ts für die Hauptfenster-Seite der
// Sync-Brücke). Von main.tsx gerendert, wenn die URL `?window=render` trägt. Gleiches Prinzip wie SettingsWindowApp.tsx:
// die Ansicht (`RenderDialogView`) bekommt Vorgaben, Stand des Auftrags und Vorschau vom Hauptfenster und schickt Befehle
// zurück; der Auftrag selbst (Szene, Cycles/Blender, Bild) bleibt im Hauptfenster.
//
// Schliessen: ohne laufenden Auftrag sofort (Auftrag zurücksetzen, Lage merken); während der Arbeit fragt die Ansicht in einem
// Overlay nach (kein window.confirm) — auch beim Kreuz der Fensterleiste (`onCloseRequested`).
//
// Bezeichner englisch, UI-Text über i18n (CONVENTIONS.md).

import { useEffect, useMemo, useRef, useState } from "react";
import { RenderDialogView } from "../ui/RenderDialog";
import { isRenderBusy, type RenderCommands } from "../state/renderJob";
import { listenBridgeState } from "./windowBridge";
import { saveWindowGeometry, type RenderSyncState } from "./renderWindow";
import { t } from "../i18n";

export function RenderWindowApp() {
  const [state, setState] = useState<RenderSyncState | null>(null);
  const [closeRequest, setCloseRequest] = useState(0);
  const busyRef = useRef(false);
  busyRef.current = state ? isRenderBusy(state.job) : false;

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      // Ganzer Zustand und Patches der Sync-Brücke ([121], `windowBridge.ts`).
      unlisten.push(...(await listenBridgeState<RenderSyncState>("render", setState)));
      // Hauptfenster um den aktuellen Stand bitten (Race-Schutz: dieses Fenster könnte nach dem letzten Sync-Push gestartet sein).
      await emitTo("main", "render-window-ready").catch(() => {});
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  // Jeder Befehl → EIN „render-command“-Event ans Hauptfenster (Name + Argumente), analog SettingsWindowApp.tsx.
  const commands = useMemo<RenderCommands>(
    () =>
      new Proxy({} as RenderCommands, {
        get(_target, prop: string) {
          return (...args: unknown[]) => {
            void import("@tauri-apps/api/event").then(({ emitTo }) => emitTo("main", "render-command", { name: prop, args }).catch(() => {}));
          };
        },
      }),
    [],
  );

  // Lage (Position, Grösse) merken, wie das Fenster beim nächsten Öffnen wieder erscheint; Kreuz der Fensterleiste abfangen.
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      if (disposed) return;
      const win = getCurrentWindow();
      const remember = async () => {
        try {
          const [pos, size, scale] = await Promise.all([win.outerPosition(), win.innerSize(), win.scaleFactor()]);
          const p = pos.toLogical(scale);
          const s = size.toLogical(scale);
          saveWindowGeometry({ x: p.x, y: p.y, width: s.width, height: s.height });
        } catch {
          /* Fenster schon weg */
        }
      };
      const later = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => void remember(), 400);
      };
      unlisten.push(await win.onMoved(later), await win.onResized(later));
      unlisten.push(
        await win.onCloseRequested((e) => {
          if (busyRef.current) {
            // Arbeit läuft: erst die Rückfrage der Ansicht (Weiter rendern / Abbrechen und schliessen).
            e.preventDefault();
            setCloseRequest((n) => n + 1);
          } else {
            void remember();
            commands.reset();
          }
        }),
      );
    })();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      unlisten.forEach((u) => u());
    };
  }, [commands]);

  // Aus der Ansicht heraus (kein Auftrag mehr bzw. Abbruch bestätigt): Fenster ohne weitere Rückfrage schliessen.
  const onClose = () => {
    commands.reset();
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().destroy());
  };

  if (!state || !state.info) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--muted)", fontSize: 13 }} data-tauri-drag-region>
        {t("resources.loading")}
      </div>
    );
  }

  return (
    <RenderDialogView
      info={state.info}
      job={state.job}
      imageSrc={state.image ? `data:image/png;base64,${state.image}` : null}
      commands={commands}
      onClose={onClose}
      closeRequest={closeRequest}
      windowed
    />
  );
}
