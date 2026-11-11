// Native macOS-Menüleiste der App ([163], aus App.tsx herausgelöst): verdrahtet `useNativeAppMenu`
// (src/native/appMenu.ts) mit Datei-, Import-/Export-, Bearbeiten-, Ansichts- und Fenster-Aktionen,
// dazu die Kennzahlen-Kurzmeldung. Ausserhalb von Tauri ein No-op (im Browser übernimmt `AppMenuBar`).
// Aufgerufen von `App.tsx`, nachdem Einstellungen, Ressourcen und Nebenfenster verdrahtet sind.

import { useMemo, type RefObject } from "react";
import type { ViewType } from "../model/types";
import { computeKennzahlen, checkRoomProgram } from "../core";
import { useNativeAppMenu } from "../native/appMenu";
import { openContextImportWindowNative } from "../native/contextImportWindow";
import { openDrawingLevelsWindowNative } from "../native/drawingLevelsWindow";
import { runClashAndStore } from "../panels/clashSession";
import { programStatusLabel } from "../panels/KennzahlenSection";
import { revealPanel } from "../panels/layout";
import { listPanels } from "../panels/registry";
import { t } from "../i18n";
import { getState, type RootState } from "./appStore";
import { openMeshFileDialog } from "./meshImportStore";
import { openPointCloudFileDialog } from "./pointCloudStore";
import { hideSelectionIn3d, showSelectionIn3d, stepActiveFloor } from "./tabNavigation";
import type { useDialogState } from "./useDialogState";
import type { useProjectFileActions } from "./useProjectFileActions";
import type { useTopBarState } from "./useTopBarState";

type TopBar = ReturnType<typeof useTopBarState>;
type Dialogs = ReturnType<typeof useDialogState>;

export function useNativeMenu(opts: {
  files: ReturnType<typeof useProjectFileActions>;
  notify: RootState["notify"];
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  setLayout: RootState["setLayout"];
  viewType: ViewType;
  setViewType: (v: ViewType) => void;
  view3d: TopBar["view3d"];
  setView3d: TopBar["setView3d"];
  referenceLines: TopBar["referenceLines"];
  setReferenceLines: TopBar["setReferenceLines"];
  resourcesOpen: boolean;
  setExportOpen: Dialogs["setExportOpen"];
  setExportDxfOpen: Dialogs["setExportDxfOpen"];
  dxfInputRef: RefObject<HTMLInputElement>;
  stepInputRef: RefObject<HTMLInputElement>;
  ifcInputRef: RefObject<HTMLInputElement>;
  hasSelectionToDelete: () => boolean;
  deleteSelection: () => void;
  onRunCommand: (name: string) => void;
  toggleResources: () => void;
  openSettings: () => void;
  openLayerSettings: (code: string, x: number, y: number) => void;
  activeCategoryCode: string;
}) {
  const {
    notify,
    undo,
    redo,
    canUndo,
    canRedo,
    setLayout,
    viewType,
    setViewType,
    view3d,
    setView3d,
    referenceLines,
    setReferenceLines,
    resourcesOpen,
    setExportOpen,
    setExportDxfOpen,
    dxfInputRef,
    stepInputRef,
    ifcInputRef,
    hasSelectionToDelete,
    deleteSelection,
    onRunCommand,
    toggleResources,
    openSettings,
    openLayerSettings,
    activeCategoryCode,
  } = opts;
  const {
    onNewProject,
    onNewProjectFromSample,
    onNewProjectFromComplexSample,
    onNewProjectFromTemplate,
    onOpenProject,
    onSaveProject,
    onSaveProjectAs,
    onExportSchedule,
    onExportIfc,
    onExportObj,
    onExportStl,
    onExportGlb,
    onExportStep,
  } = opts.files;

  // Panel-Liste für „Fenster > Panels" (native Menüleiste) — die Registry ist
  // statisch (Panels tragen sich beim Modul-Import ein), daher einmalig.
  const nativeMenuPanels = useMemo(
    () => listPanels().map((p) => ({ id: p.id, label: t(p.title) })),
    [],
  );

  // Native macOS-Systemmenüleiste (oben am Bildschirm) — dieselben Aktionen
  // wie AppMenuBar/QuickAccess, nur als echter App-Menü-Baum. No-op ausserhalb
  // von Tauri (isTauriRuntime-Guard steckt im Hook selbst).
  useNativeAppMenu(
    {
      onNewProject,
      onNewProjectFromSample,
      onNewProjectFromComplexSample,
      onNewProjectFromTemplate,
      onOpenProject,
      onSaveProject,
      onSaveProjectAs,
      onImport: () => dxfInputRef.current?.click(),
      onExportPdf: () => setExportOpen(true),
      onExportDxf: () => setExportDxfOpen(true),
      onExportSchedule,
      onExportIfc,
      onExportObj,
      onExportStl,
      onExportGlb,
      onExportStep,
      onImportStep: () => stepInputRef.current?.click(),
      onImportIfc: () => ifcInputRef.current?.click(),
      onImportPointCloud: () => openPointCloudFileDialog(),
      onImportMesh: () => openMeshFileDialog(),
      onClashCheck: () => {
        setLayout((l) => revealPanel(l, "clash"));
        void runClashAndStore();
      },
      onKennzahlen: () => {
        const project = getState().project;
        const k = computeKennzahlen(project);
        const prog = checkRoomProgram(project);
        const f = (n: number, d = 1) => n.toFixed(d);
        const lines = [
          t("kennzahlen.summary", { gf: f(k.gf), agf: f(k.agf), gv: f(k.gv) }),
          k.az !== null && k.uez !== null ? t("kennzahlen.ziffern", { az: f(k.az, 2), uez: f(k.uez, 2) }) : t("kennzahlen.noParcel"),
        ];
        if (prog.rows.length > 0) {
          const bad = prog.rows.filter((r) => r.status !== "ok");
          lines.push(t("kennzahlen.program", { ok: prog.rows.length - bad.length, n: prog.rows.length }));
          for (const r of bad.slice(0, 4)) lines.push(t("kennzahlen.programIssue", { name: r.name, status: programStatusLabel(r.status) }));
        }
        notify(lines.join(" — "), "info");
      },
      onUndo: undo,
      onRedo: redo,
      onDeleteSelection: deleteSelection,
      onMove: () => onRunCommand("move"),
      onMirror: () => onRunCommand("mirror"),
      onRotate: () => onRunCommand("rotate"),
      onViewType: setViewType,
      onView3d: setView3d,
      onReferenceLines: setReferenceLines,
      onFloorStep: stepActiveFloor,
      onShowSelection3d: showSelectionIn3d,
      onHideSelection3d: hideSelectionIn3d,
      onToggleResources: () => toggleResources(),
      onOpenSettings: () => openSettings(),
      onOpenPanel: (panelId) => setLayout((l) => revealPanel(l, panelId)),
      onOpenDrawingLevelsWindow: () => void openDrawingLevelsWindowNative(),
      onOpenLayerSettingsWindow: () => openLayerSettings(activeCategoryCode, 0, 0),
      onOpenContextImportWindow: () => void openContextImportWindowNative(),
    },
    {
      canUndo,
      canRedo,
      hasSelection: hasSelectionToDelete(),
      viewType,
      view3d,
      referenceLines,
      resourcesOpen,
    },
    nativeMenuPanels,
  );
}
