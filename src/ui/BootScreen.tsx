// Boot-Sequenz der App ([163], aus App.tsx herausgelöst): Splash → Startbildschirm (Neu, Öffnen,
// Zuletzt geöffnet, Autosave wiederherstellen) → Editor, wie bei den meisten CAD-Programmen. Läuft nur
// einmal pro Fensterstart; unter Tauri passt `useBootPhase` die Fenstergrösse der Phase an.
// `App.tsx` ruft `useBootPhase` als ersten Hook und rendert `BootScreen`, bis der Editor erreicht ist.

import { useEffect, useState } from "react";
import { isTauriRuntime } from "../native/projectFile";
import type { useProjectFileActions } from "../state/useProjectFileActions";
import type { NotifyKind } from "../state/notifySlice";
import { t } from "../i18n";
import { RecoverAutosaveDialog } from "./RecoverAutosaveDialog";
import { SplashScreen } from "./SplashScreen";
import { StartScreen } from "./StartScreen";

export type BootPhase = "splash" | "start" | "editor";

export function useBootPhase() {
  // Wie bei den meisten CAD-Programmen (s. ui/SplashScreen.tsx/StartScreen.tsx).
  // Läuft NUR einmal pro Fensterstart; sobald "editor" erreicht ist, bleibt der
  // volle Editor bestehen (auch bei späteren File>Neu/Öffnen-Aktionen, die
  // weiterhin über das normale Menü laufen).
  const [bootPhase, setBootPhase] = useState<BootPhase>("splash");

  // Fenstergrösse an die Boot-Phase anpassen: Splash/Startbildschirm sind ein
  // kleines, kompaktes Fenster (wie das Start-Fenster gängiger CAD-Programme),
  // NICHT die volle Editor-Fenstergrösse — sonst wirkt der Startbildschirm wie
  // leerer Raum in einem viel zu grossen Fenster. Beim Wechsel in "editor" auf
  // die Standardgrösse aus tauri.conf.json zurück + zentrieren. Nur unter
  // Tauri relevant (Browser-Fenster lässt sich per Web-API nicht sinnvoll
  // resizen).
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void (async () => {
      const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
        import("@tauri-apps/api/window"),
        import("@tauri-apps/api/dpi"),
      ]);
      const win = getCurrentWindow();
      const [w, h] = bootPhase === "editor" ? [1400, 900] : [520, 420];
      await win.setSize(new LogicalSize(w, h));
      await win.center();
    })();
  }, [bootPhase]);

  return [bootPhase, setBootPhase] as const;
}

/** Splash bzw. Startbildschirm (samt Autosave-Wiederherstellung) vor dem Editor. */
export function BootScreen(props: {
  phase: Exclude<BootPhase, "editor">;
  setPhase: (p: BootPhase) => void;
  files: ReturnType<typeof useProjectFileActions>;
  notify: (message: string, kind?: NotifyKind) => void;
}) {
  const { phase, setPhase, notify } = props;
  const { onNewProject, onOpenProject, openProjectAtPath, recovery, onRecoverRestore, onRecoverDiscard, onRecoverLater } = props.files;
  if (phase === "splash") {
    return <SplashScreen onDone={() => setPhase("start")} />;
  }
  return (
    <>
    <StartScreen
      onNewProject={() => {
        onNewProject();
        setPhase("editor");
      }}
      onOpenProject={() => {
        onOpenProject();
        setPhase("editor");
      }}
      onOpenRecent={(path) => {
        void openProjectAtPath(path).then((found) => {
          if (!found) notify(t("start.recentMissing"), "error");
        });
        setPhase("editor");
      }}
    />
    {recovery && (
      <RecoverAutosaveDialog
        path={recovery.path}
        savedAt={recovery.savedAt}
        onRestore={() => {
          onRecoverRestore();
          setPhase("editor");
        }}
        onDiscard={onRecoverDiscard}
        onLater={onRecoverLater}
      />
    )}
    </>
  );
}
