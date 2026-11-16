// Einstellungen der App ([163], aus App.tsx herausgelöst): Start-Protokoll (Hinweis nach unsauberem
// Ende), Offline-Modus, KI-Zugriff, Hell/Dunkel, projektweite Linien-Einstellungen und der Abgleich mit
// dem nativen Einstellungsfenster (Tauri). Aufgerufen von `App.tsx`; die Rückgaben speisen den
// `SettingsDialog` (Browser) und `openSettings` die Menüs und Panels.

import { useEffect, useState, type RefObject } from "react";
import { lineEndsOf, setFieldIfChanged, type LineEnds } from "../core";
import { isOffline, setOffline } from "../net/net";
import { isTauriRuntime } from "../native/projectFile";
import { openSettingsWindowNative, useSettingsWindowHost } from "../native/settingsWindow";
import { useThemeModeState } from "../theme/useThemeMode";
import type { PlanViewHandle } from "../views/plan/PlanView";
import { applyLanguagePref, getStoredLanguagePref, setStoredLanguagePref, t, type LanguagePref } from "../i18n";
import { useStore, type RootState } from "./appStore";
import { setAiAccessEnabled, setAiView, useAiAccess } from "./aiAccess";
import { reconcileLayout } from "./layoutSlice";
import { markSessionClean, markSessionStart } from "./startupGuard";
import type { useDialogState } from "./useDialogState";
import type { useTopBarState } from "./useTopBarState";

type TopBar = ReturnType<typeof useTopBarState>;

/** [264] Der Sprachwechsel baut die App neu auf (`LanguageRoot`); der Einstellungsdialog soll danach wieder offen sein. */
let reopenSettingsAfterLanguageChange = false;
/** Das Start-Protokoll läuft einmal je Seitenladen, nicht bei jedem Neuaufbau der App ([264]). */
let sessionMarked = false;

export function useSettingsHost(opts: {
  applyChange: RootState["applyChange"];
  groupChanges: RootState["groupChanges"];
  notify: RootState["notify"];
  layout: RootState["layout"];
  setLayout: RootState["setLayout"];
  marqueeColor: TopBar["marqueeColor"];
  setMarqueeColor: TopBar["setMarqueeColor"];
  snapColor: TopBar["snapColor"];
  setSnapColor: TopBar["setSnapColor"];
  planViewRef: RefObject<PlanViewHandle>;
  setSettingsOpen: ReturnType<typeof useDialogState>["setSettingsOpen"];
}) {
  const {
    applyChange,
    groupChanges,
    notify,
    layout,
    setLayout,
    marqueeColor,
    setMarqueeColor,
    snapColor,
    setSnapColor,
    planViewRef,
    setSettingsOpen,
  } = opts;

  useEffect(() => {
    if (!reopenSettingsAfterLanguageChange) return;
    reopenSettingsAfterLanguageChange = false;
    if (!isTauriRuntime()) setSettingsOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start-Protokoll: war der letzte Lauf unsauber beendet, kurz darauf hinweisen (Autosave sichert
  // die Daten); beim Schliessen die Sitzung als sauber markieren.
  useEffect(() => {
    const r = sessionMarked ? { previousCrashed: false } : markSessionStart();
    sessionMarked = true;
    if (r.previousCrashed) notify(t("startup.previousCrashed"), "warning");
    const clean = () => markSessionClean();
    window.addEventListener("pagehide", clean);
    return () => window.removeEventListener("pagehide", clean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Offline-Modus (Einstellungen → Allgemein): sperrt alle entfernten Abrufe (src/net/net.ts).
  const [offline, setOfflineState] = useState<boolean>(() => isOffline());
  const onOfflineChange = (v: boolean) => {
    setOffline(v);
    setOfflineState(v);
  };

  // [264] Sprache der Oberfläche (Einstellungen → Allgemein): sofort wirksam, gespeichert in localStorage.
  const [languagePref, setLanguagePrefState] = useState<LanguagePref>(() => getStoredLanguagePref());
  const onLanguagePrefChange = (pref: LanguagePref) => {
    setStoredLanguagePref(pref);
    reopenSettingsAfterLanguageChange = true;
    applyLanguagePref(pref);
    setLanguagePrefState(pref);
  };

  // [9] KI-Zugriff (MCP-Brücke, Einstellungen → Allgemein): Stand für die Einstellungen; die
  // Planansicht für `zoom_to` anmelden.
  const aiAccessState = useAiAccess();
  const aiAccess = { enabled: aiAccessState.enabled, token: aiAccessState.token, port: aiAccessState.port, status: aiAccessState.status };
  useEffect(() => {
    setAiView({ fitBounds: (pts) => planViewRef.current?.fitBounds(pts) });
    return () => setAiView(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hell/Dunkel (Einstellungen → Darstellung). Standard Hell (styles.css);
  // Dunkel ist Opt-in und persistiert in localStorage.
  const { themeMode, setThemeMode } = useThemeModeState();

  // Einstellungen als eigenes natives Fenster (Tauri) statt Overlay-Dialog —
  // hält es (falls offen) synchron zu den betroffenen Feldern, wendet dessen
  // Befehle auf die echten Setter an (siehe native/settingsWindow.ts).
  const setScaleLineWeights = (on: boolean) =>
    applyChange((p) => setFieldIfChanged(p, "scaleLineWeights", on ? true : undefined));
  // [146] Linienenden/-ecken: Standard (flach, Gehrung) = Feld weglassen; beide Felder ein Undo-Schritt.
  const setLineEnds = (e: LineEnds) =>
    groupChanges(() => {
      applyChange((p) => setFieldIfChanged(p, "lineCap", e.cap === "butt" ? undefined : e.cap));
      applyChange((p) => setFieldIfChanged(p, "lineJoin", e.join === "miter" ? undefined : e.join));
    });
  // Nur die drei Projekt-Felder abonnieren, die das Fenster zeigt ([121]).
  const referenceElevationMasl = useStore((s) => s.project.referenceElevationMasl);
  const scaleLineWeights = useStore((s) => s.project.scaleLineWeights === true);
  const lineCap = useStore((s) => s.project.lineCap);
  const lineJoin = useStore((s) => s.project.lineJoin);
  useSettingsWindowHost(
    {
      themeMode,
      marqueeColor,
      snapColor,
      referenceElevationMasl,
      scaleLineWeights,
      lineEnds: lineEndsOf({ lineCap, lineJoin }),
      offline,
      languagePref,
      aiAccess,
      layout,
    },
    {
      onThemeModeChange: setThemeMode,
      onMarqueeColorChange: setMarqueeColor,
      onSnapColorChange: setSnapColor,
      onReferenceElevationChange: (n) => applyChange((p) => setFieldIfChanged(p, "referenceElevationMasl", n)),
      onScaleLineWeightsChange: setScaleLineWeights,
      onLineEndsChange: setLineEnds,
      onOfflineChange,
      onLanguagePrefChange,
      onAiAccessChange: setAiAccessEnabled,
      onApplyLayout: (l) => setLayout(reconcileLayout(l)),
    },
  );
  const openSettings = () => {
    if (isTauriRuntime()) {
      void openSettingsWindowNative();
    } else {
      setSettingsOpen(true);
    }
  };

  return { themeMode, setThemeMode, offline, onOfflineChange, languagePref, onLanguagePrefChange, aiAccess, setScaleLineWeights, setLineEnds, openSettings };
}
