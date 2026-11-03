// Wurzel der App: ein semantisches Projekt im React-State; jede Ansicht wird
// daraus abgeleitet. Die Oberfläche läuft auf dem Panel-System (src/panels):
// links (und optional rechts) je ein Dock mit Tabs, dazwischen die Hauptansicht.
// Die beiden dockbaren Kern-Panels (Zeichnungsebenen, Ebenen) registrieren sich
// über den Import von builtinPanels und beziehen Zustand + Handler aus dem
// PanelHostContext — kein Prop-Drilling mehr.
//
// „Ressourcen" ist KEIN Dock-Panel: der ResourceManager ist ein schwebendes
// Fenster (Overlay über allem), das die Oberleiste öffnet und über X / Klick auf
// den abgedunkelten Hintergrund / Esc schließt. Ein leeres Dock wird nicht
// gerendert, damit die Mitte (Grundriss/Perspektive) die Breite voll nutzt.
//
// Bearbeitung läuft ausschließlich immutabel über setProject. Sichtbare
// Kategorie-Codes (collectVisibleCodes) steuern, was Grundriss und 3D zeigen.
// Der Darstellungsmodus je Panel (DisplayMode) verfeinert das zusätzlich (die
// fünf DOSSIER-Modi): das Zeichnungsebenen-Panel steuert das 3D, das
// Ebenen-Panel die Kategorie-Darstellung in Grundriss UND 3D.

import { lengthFromDisplay, unitsForLevel } from "./tools/displayUnits";
import { NON_LENGTH_FIELDS } from "./commands/parseInput";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDormerNotice } from "./state/useDormerNotice";
import { collectVisibleCodes } from "./model/types";
import type {
  ContextObject,
  Drawing2D,
  Vec2,
  Wall,
} from "./model/types";
import { activePenSet, resolvePenColor, resolvePenWeight } from "./model/penSets";
import { PenColorField } from "./ui/PenColorField";
import { generatePlan, computeKennzahlen, checkRoomProgram } from "./core";
import { addedItems } from "./core";
import { programStatusLabel } from "./panels/KennzahlenSection";
import { sectionPlaneFromLevel, sectionUAxisModel } from "./core";
import { setDxfImportTrigger } from "./io/dxfImportHook";
import { ImportDialog } from "./ui/ImportDialog";
import { BusyOverlay } from "./ui/BusyOverlay";
import { ExportPdfDialog } from "./ui/ExportPdfDialog";
import { ExportDxfDialog } from "./ui/ExportDxfDialog";
import { SettingsDialog } from "./ui/SettingsDialog";
import { OpeningEditorDialog } from "./ui/OpeningEditorDialog";
import { ExportSaveDialog } from "./ui/ExportSaveDialog";
import { PromptDialog } from "./ui/PromptDialog";
import { LockConflictDialog } from "./ui/LockConflictDialog";
import { UnsavedChangesDialog } from "./ui/UnsavedChangesDialog";
import { RecoverAutosaveDialog } from "./ui/RecoverAutosaveDialog";
import { Toast } from "./ui/Toast";
import { isTauriRuntime, PROJECT_TEMPLATE_EXT } from "./native/projectFile";
import { readStepFlat } from "./engine/truckSolid";
import { formatIfcElementsSummary, formatIfcReport, readIfcFlat } from "./io/ifcImport";
import { IfcImportDialog, type IfcImportMode } from "./ui/IfcImportDialog";
import { MeshImportHost } from "./ui/MeshImportDialog";
import { openMeshFileDialog, requestMeshImport, splitMeshFiles } from "./state/meshImportStore";
import { formatMeshReport, isMeshFile, type MeshPlacement, type MeshRead } from "./io/meshImport";
import { runClashAndStore } from "./panels/clashSession";
import { checkForUpdate } from "./update/checkForUpdate";
import type { PlanViewHandle } from "./views/plan/PlanView";
import { grip3dEditFields } from "./viewport/grip3dHud";
import { useGrip3dEditing } from "./state/useGrip3dEditing";
import { useCommandEngineHost } from "./state/useCommandEngineHost";
import { useEventBundle } from "./state/useEvent";
import { useSheetPane } from "./state/useSheetPane";
import { useDisplayResolvers } from "./state/useDisplayResolvers";
import { ResourceManager } from "./ui/ResourceManager";
import type { ResourceManagerHandlers, TabId as ResourceTabId } from "./ui/ResourceManager";
import {
  effectiveSheetSizeMm,
  findMaster,
  isSheetLevel,
  sheetMmToModel,
  SHEET_SCALE_DENOMINATOR,
} from "./model/layoutModel";
import { HatchSwatch } from "./ui/hatchPreview";
import { TopBar, ViewRibbonTab } from "./ui/TopBar";
import { AppMenuBar } from "./ui/AppMenuBar";
import { PointCloudImportHost } from "./ui/PointCloudImportDialog";
import { openPointCloudFileDialog, requestPointCloudImport } from "./state/pointCloudStore";
import { isPointCloudFile } from "./io/pointCloud";
import { EditorField } from "./ui/EditorField";
import { useNativeAppMenu } from "./native/appMenu";
import { openResourceWindowNative, useResourceWindowHost } from "./native/resourceWindow";
import { openSettingsWindowNative, useSettingsWindowHost } from "./native/settingsWindow";
import {
  openDrawingLevelsWindowNative,
  useDrawingLevelsWindowHost,
} from "./native/drawingLevelsWindow";
import {
  openLayerSettingsWindowNative,
  useLayerSettingsWindowHost,
} from "./native/layerSettingsWindow";
import {
  openContextImportWindowNative,
  useContextImportWindowHost,
} from "./native/contextImportWindow";
import { TextEditorDialog } from "./ui/TextEditorDialog";
import { RoomStampEditor } from "./panels/RoomStampEditor";
import { defaultRoomStamp } from "./model/roomStamp";
import { StatusBar } from "./ui/StatusBar";
import { isOffline, setOffline } from "./net/net";
import { setAiAccessEnabled, setAiView, useAiAccess } from "./state/aiAccess";
import { AiActivityPanel } from "./ui/AiActivityPanel";
import { markSessionClean, markSessionStart } from "./state/startupGuard";
import { toolInfo } from "./tools/tools";
import { computeSnap } from "./tools/snapping";
import type {
  ToolHandlers,
  ToolId,
  ToolMods,
} from "./tools/types";
import { ContextMenu } from "./ui/ContextMenu";
import {
  categoryNames,
  isolateCategories,
  selectionCategoryCodes,
  setCategoriesVisible,
} from "./state/selectionLayers";
import { buildMenuItems, menuTitle } from "./menus/contextMenu";
import { useContextMenuState } from "./menus/useContextMenuState";
import { InlineEditor } from "./views/InlineEditor";
import { Content } from "./views/viewportContent";
import { useDialogState } from "./state/useDialogState";
import { useTopBarState } from "./state/useTopBarState";
import { setCursor } from "./state/cursorStore";
import { setLiveScale } from "./state/liveScaleStore";
import { useDrawingToolState } from "./state/useDrawingToolState";
import { useSelectionState } from "./state/useSelectionState";
import { useGripEditing } from "./state/useGripEditing";
import { usePanelHostBase } from "./state/usePanelHostBase";
import { useDockDragState } from "./state/useDockDragState";
import { useMouseSelectionHandlers } from "./state/useMouseSelectionHandlers";
import { containingGroupId, EMPTY_MEMBERSHIP } from "./state/groupActions";
import { addItems, cmdMutation, fieldOps, opsMutation, patchItem, patchItems, removeItems, setFieldIfChanged } from "./core";
import type { GroupMembership, MemberKind } from "./state/groupActions";
import { isLocked, lockMembersOps } from "./state/objectLock";
import { useProjectFileActions } from "./state/useProjectFileActions";
import { useProjectActions } from "./state/useProjectActions";
import {
  useActiveToolKeys,
  useBooleanOpsShortcut,
  useElementClipboardShortcut,
  useGroupShortcut,
  useSelectAllAndDeleteShortcut,
  useSplitJoinShortcut,
  useToolNumberShortcuts,
  useTransformShortcuts,
  useUndoRedoShortcut,
} from "./state/useKeyboardShortcuts";
import { useFileDropImport, useImageImportHandling } from "./state/useImportHandling";
import { useExportHandlers } from "./state/useExportHandlers";
import { useThemeModeState } from "./theme/useThemeMode";
import { CommandLine } from "./ui/CommandLine";
import type { EngineMods, EngineView } from "./commands/engine";
import { t, useT } from "./i18n";
import { cutSegmentOps, splitOps } from "./editors/splitJoin";
import {
  countClosedAreas,
  differenceDrawings,
  intersectionDrawings,
  unionDrawings,
} from "./editors/booleanOps";
import type { BooleanResult } from "./editors/booleanOps";
import { applyDrawingStyleOps, readDrawingStyle } from "./editors/matchProps";

// Globaler Store (Slices: project/selection/view/layout).
import { getState, useStore } from "./state/appStore";
import { categoryLabel, findCategory } from "./model/layers";
import { reconcileLayout } from "./state/layoutSlice";

// Panel-System.
import { Dock } from "./panels/Dock";
import { FloatingPanel } from "./panels/FloatingPanel";
import { DragOverlay } from "./panels/panelDrag";
import { hostWithMode, PanelHostProvider } from "./panels/host";
import { deriveSelection } from "./state/selectionInfo";
import type { Selection } from "./state/selectionInfo";
import { centroid as roomCentroid } from "./core";
import { docFromText, plainText, DEFAULT_PRESETS } from "./text/richText";
import type { RichTextDoc } from "./text/richText";
import { revealPanel, saveLayout } from "./panels/layout";
import { listPanels } from "./panels/registry";
import {
  deleteDrawingCombo,
  deleteLayerCombo,
  listDrawingCombos,
  listLayerCombos,
  loadDrawingCombo,
  loadLayerCombo,
  saveDrawingCombo,
  saveLayerCombo,
} from "./state/visibilitySets";
import {
  readViewSnapshot,
  snapshotMatchesLiveState,
  type ViewSnapshotState,
} from "./state/viewSnapshots";
import { useViewTemplateHandlers } from "./state/useViewTemplateHandlers";
// Seiteneffekt: registriert die zwei dockbaren Kern-Panels in der Registry.
import { BUILTIN_PANEL_IDS } from "./panels/builtinPanels";
import { SplashScreen } from "./ui/SplashScreen";
import { StartScreen } from "./ui/StartScreen";

/**
 * Offenes Kontextmenü — genau eine Quelle. `x/y` sind Viewport-Pixel (clientX/Y).
 *   • "layer"    — Rechtsklick auf eine Ebenen-Zeile (Kategorie-Code).
 *   • "level"    — Rechtsklick auf eine Zeichnungsebenen-Zeile (Ebenen-ID).
 *   • "plan"     — Rechtsklick im Grundriss (optional getroffene Wand).
 *   • "viewport" — Rechtsklick im 3D (optional getroffene Wand).
 */
/**
 * Befehlsname für ein gekoppeltes Werkzeug (oder null). Die Zeichen-Werkzeuge der Palette sind
 * Engine-Befehle: ein Klick auf das Werkzeug startet diesen Befehl (`tools/tools.ts`, [123]).
 */
function coupledCommandFor(id: ToolId): string | null {
  return toolInfo(id).command ?? null;
}

/** Transformations-Befehle der Auswahl: Rechtsklick bricht ab, Geschoss-/Ansichtswechsel auch. */
const TRANSFORM_COMMANDS = new Set(["move", "rotate", "mirror"]);

/** Keine Inline-Optionen (stabile Identität für die memoisierte Befehlszeile, [121]). */
const NO_OPTIONS: EngineView["options"] = [];

export default function App() {
  // Sprachwechsel abonnieren: re-rendert den gesamten Baum, wenn die Sprache
  // umgeschaltet wird (alle Kinder lesen denselben modulweiten Zustand über t).
  useT();

  // ── Boot-Sequenz: Splash → Startbildschirm (Neu/Öffnen/Zuletzt) → Editor ──
  // Wie bei den meisten CAD-Programmen (s. ui/SplashScreen.tsx/StartScreen.tsx).
  // Läuft NUR einmal pro Fensterstart; sobald "editor" erreicht ist, bleibt der
  // volle Editor bestehen (auch bei späteren File>Neu/Öffnen-Aktionen, die
  // weiterhin über das normale Menü laufen).
  const [bootPhase, setBootPhase] = useState<"splash" | "start" | "editor">("splash");

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

  // ── Globaler Zustand aus dem Store (Slices: project/selection/view/layout) ─
  // Pro useStore-Aufruf EIN Feld selektieren (Referenz-Gleichheit, sonst
  // Endlosschleife). Actions leben ebenfalls im Zustand und sind referenzstabil.
  const project = useStore((s) => s.project);
  const setProject = useStore((s) => s.setProject);
  const applyChange = useStore((s) => s.applyChange);
  const groupChanges = useStore((s) => s.groupChanges);
  const notify = useStore((s) => s.notify);
  useDormerNotice(project, notify);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const activeLevelId = useStore((s) => s.activeLevelId);
  const setActiveLevelId = useStore((s) => s.setActiveLevelId);
  const viewType = useStore((s) => s.viewType);
  const setViewType = useStore((s) => s.setViewType);

  // Dialog-/Overlay-Sichtbarkeit der App-Shell (Ressourcen-Fenster, Layout-
  // Ansicht, Import/Export/Einstellungen, Drop-Feedback) — rein lokaler UI-
  // State, siehe state/useDialogState.ts.
  const {
    resourcesOpen,
    setResourcesOpen,
    resourcesTab,
    setResourcesTab,
    openingEditorId,
    setOpeningEditorId,
    activeLayoutId,
    setActiveLayoutId,
    importState,
    setImportState,
    exportOpen,
    setExportOpen,
    exportDxfOpen,
    setExportDxfOpen,
    settingsOpen,
    setSettingsOpen,
    exportSaveFormat,
    setExportSaveFormat,
    dropActive,
    setDropActive,
  } = useDialogState();

  // ── Oberleisten-/Status-Zustand (View-State, kein Modell) ─────────────────
  // detail wirkt im Grundriss (Symbole + Schraffuren/Linien), renderMode in der
  // 3D-Ansicht (3 Modi), referenceLines schaltet die Wand-Achslinien.
  const {
    detail,
    setDetail,
    renderMode,
    setRenderMode,
    view3d,
    setView3d,
    fov,
    setFov,
    grid3dVisible,
    setGrid3dVisible,
    planColorMode,
    setPlanColorMode,
    referenceLines,
    setReferenceLines,
    lineMode,
    setLineMode,
    marqueeColor,
    setMarqueeColor,
    snapColor,
    setSnapColor,
    scaleDenominator,
    setScaleDenominator,
    selectedViewSnapshotId,
    setSelectedViewSnapshotId,
  } = useTopBarState();

  // ── Zeichenwerkzeuge (transienter View-State; bleibt lokal) ───────────────
  // Aktives Werkzeug, Werkzeug-Parameter (Wandtyp/Kategorie/Linienstil), Snap-
  // Einstellungen sowie der laufende Werkzeug-Zustand (Ref, kein Re-Render je
  // Mausbewegung) und die Live-Vorschau (Draft → Overlay in PlanView).
  const {
    activeTool,
    setActiveTool,
    activeWallTypeId,
    setActiveWallTypeId,
    activeCategoryCode,
    setActiveCategoryCode,
    activeLineStyleId,
    snap,
    setSnap,
    draft,
    setDraft,
    pendingCopyMode,
    setPendingCopyMode,
    requestCopyCount,
    commitCopyCount,
  } = useDrawingToolState(project.wallTypes[0].id, project.lineStyles[0].id);

  // ── Auswahl (Store-Slice) ─────────────────────────────────────────────────
  const {
    selectedWallIds,
    setSelectedWallIds,
    selectedDrawingIds,
    setSelectedDrawingIds,
    selectedDrawingId,
    setSelectedDrawingId,
    elementClipboard,
    setElementClipboard,
    selectedWallId,
    selectedCeilingIds,
    setSelectedCeilingIds,
    selectedCeilingId,
    selectedRoofIds,
    setSelectedRoofIds,
    selectedRoofId,
    selectedSectionLineIds,
    setSelectedSectionLineIds,
    selectedSectionLineId,
    section3dCutId,
    setSection3dCutId,
    updateRoof,
    moveRoofGrip,
    moveRoofBy,
    selectedOpeningIds,
    setSelectedOpeningIds,
    selectedOpeningId,
    selectedStairIds,
    setSelectedStairIds,
    selectedStairId,
    selectedRoomIds,
    setSelectedRoomIds,
    selectedRoomId,
    selectedExtrudedSolidIds,
    setSelectedExtrudedSolidIds,
    selectedExtrudedSolidId,
    selectedColumnIds,
    setSelectedColumnIds,
    selectedColumnId,
    selectedContextObjectIds,
    setSelectedContextObjectIds,
    selectedGroupIds,
    setSelectedGroupIds,
    groupPath,
    setGroupPath,
  } = useSelectionState();

  // ── Kontextmenüs (transienter UI-State, bleibt lokal) ─────────────────────
  const {
    layerClipboard,
    setLayerClipboard,
    drawingStyleClipboard,
    setDrawingStyleClipboard,
    menu,
    setMenu,
    editor,
    setEditor,
    nativeLayerSettingsCode,
    setNativeLayerSettingsCode,
    stampEditorRoomId,
    setStampEditorRoomId,
    editTextId,
    setEditTextId,
    editTextMinHeightM,
    setEditTextMinHeightM,
  } = useContextMenuState();

  // Beim Geschosswechsel die Wand-Auswahl + offene Overlays zurücksetzen (die
  // Wände eines anderen Geschosses sind eine andere Menge). Der Ansichtswechsel
  // (Grundriss ↔ 3D) lässt die Auswahl bestehen — dieselbe wallId gilt in
  // beiden Ansichten; nur die offenen Overlays werden geschlossen.
  useEffect(() => {
    setSelectedWallIds([]);
    setSelectedDrawingId(null);
    setSelectedCeilingIds([]);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedRoomIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
    setSelectedSectionLineIds([]);
    setMenu(null);
    setEditor(null);
  }, [activeLevelId]);
  useEffect(() => {
    setMenu(null);
    setEditor(null);
  }, [viewType]);

  // Imperatives Handle der Plan-Ansicht (für die Zoom-Buttons der Oberleiste).
  // useRef<T>(null) → RefObject<T> (current: T) — die für ein ref-Prop passende
  // Form; .current bleibt zur Laufzeit null, solange PlanView nicht montiert ist
  // (Optional-Chaining unten fängt das ab).
  const planViewRef = useRef<PlanViewHandle>(null);

  // Verstecktes Datei-Input für den DXF-Import (Site-Panel/„import"-Befehl).
  // Der Klick auf „DXF importieren" triggert .click() dieses Inputs; onChange
  // öffnet den Import-Dialog; übernommen wird im Kern (`ProjectDocument.importDrawing`).
  const dxfInputRef = useRef<HTMLInputElement>(null);
  // Verstecktes Datei-Input für den STEP-Import (Menü Datei, STEP importieren).
  const stepInputRef = useRef<HTMLInputElement>(null);
  // Verstecktes Datei-Input für den IFC-Import ([B3], Menü Datei, IFC importieren).
  const ifcInputRef = useRef<HTMLInputElement>(null);

  // Verstecktes Datei-Input für „Bild einfügen" (Werkzeug „image", s. tools.ts-
  // Kommentar) — akzeptiert auch PDF (jede Seite wird gerastert, s. pdfImport.ts);
  // beides landet als Drawing2D `{shape:"image"}`, direkt selektiert.
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Den DXF-Datei-Dialog-Öffner für den „import"-Befehl registrieren (entkoppelt
  // über den Modul-Hook). Beim Unmount wieder abmelden.
  useEffect(() => {
    setDxfImportTrigger(() => dxfInputRef.current?.click());
    return () => setDxfImportTrigger(null);
  }, []);

  // Selbst-Update: einmalig beim Start prüfen (still — meldet sich nur bei
  // einem gefundenen Update oder einem echten Fehler, s. checkForUpdate.ts).
  // No-op ausserhalb von Tauri (Vite-Dev-Server im Browser).
  useEffect(() => {
    checkForUpdate(true);
  }, []);

  // Panel-Layout (Docks/Tabs/Größen) — aus dem Store-Slice (Init lädt aus
  // localStorage + reconcile). Bei jeder Änderung zurückspeichern.
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const modeFor = useStore((s) => s.modeFor);
  const setModeFor = useStore((s) => s.setModeFor);
  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  // Esc schließt das schwebende Ressourcen-Fenster (nur registriert, solange es
  // offen ist).
  useEffect(() => {
    if (!resourcesOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setResourcesOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resourcesOpen]);

  const activeLevel =
    project.drawingLevels.find((z) => z.id === activeLevelId) ??
    project.drawingLevels[0];
  // Massstab der Arbeitsebene: auf einem Blatt Papier 1:1, sonst der gewählte Plan-Massstab.
  const planScale = isSheetLevel(activeLevel) ? SHEET_SCALE_DENOMINATOR : scaleDenominator;
  // Anzeige-Einheiten (Lineale, Statusleiste, HUD, Befehlszeile): auf einem Blatt Papier-mm ([93]).
  const displayUnits = unitsForLevel(activeLevel);

  // Sichtbare Kategorie-Codes — Basisfilter für Grundriss & 3D.
  const visibleCodes = useMemo(
    () => collectVisibleCodes(project.layers),
    [project.layers],
  );

  // ── Plan-Eingabe → Befehls-Engine ─────────────────────────────────────────
  // PlanView meldet rohe Modellpunkte hierher; alles Zeichnen und Transformieren läuft über die
  // Engine ([123]). Beim Werkzeug-/Geschoss-/Ansichtswechsel die Vorschau verwerfen; eine laufende
  // Transformation endet bei Geschoss-/Ansichtswechsel.
  useEffect(() => {
    setDraft(null);
  }, [activeTool, activeLevelId, viewType]);
  useEffect(() => {
    const eng = engineRef.current;
    if (eng && TRANSFORM_COMMANDS.has(eng.activeCommandName() ?? "")) eng.cancel();
  }, [activeLevelId, viewType]);

  // Snap ohne Entwurfspunkte (Griff-Ziehen, s. useGripEditing).
  const snapFor = (raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
    const pts: Vec2[] = [];
    return computeSnap({
      raw,
      project,
      levelId: activeLevel.id,
      visibleCodes,
      settings: snap,
      draftPoints: pts,
      lastPoint: pts.length ? pts[pts.length - 1] : null,
      pxPerMeter,
      shift: mods.shift,
      ctrl: mods.ctrl,
    });
  };

  const toolHandlers: ToolHandlers = {
    onToolMove: (raw, _pxPerMeter, mods) => {
      // Läuft ein Befehl, übernimmt die Engine die Plan-Eingabe (ein Eingabepfad).
      // Modifikatoren (Shift=Ortho, Ctrl=Snap aus) mitgeben, damit auch der ERSTE
      // Punkt sauber snappt bzw. unterdrückt werden kann. Ohne Befehl: nur Hover.
      engineRef.current?.move(raw, { shift: mods.shift, ctrl: mods.ctrl });
    },
    onToolClick: (raw, _pxPerMeter, mods) => {
      const em = { shift: mods.shift, ctrl: mods.ctrl };
      if (engineRef.current?.isActive()) {
        engineRef.current.pick(raw, em);
        return;
      }
      // Gekoppeltes Werkzeug, aber der Befehl ist (nach Commit) beendet: denselben
      // Befehl neu starten und den Klick als ersten Punkt durchreichen — so bleibt
      // das Werkzeug wie in einem CAD armiert. Der erste Punkt snappt ebenfalls.
      const cmd = coupledCommandFor(activeTool);
      if (cmd) {
        engineRef.current?.start(cmd);
        engineRef.current?.pick(raw, em);
      }
    },
    onToolCommit: () => {
      // Rechtsklick im Viewport = Enter an die Engine (§2.3); in einer Transformation = abbrechen.
      const eng = engineRef.current;
      if (!eng?.isActive()) return;
      if (TRANSFORM_COMMANDS.has(eng.activeCommandName() ?? "")) eng.cancel();
      else eng.confirm();
    },
    draft,
  };

  // ── Command-Engine (Rhino-artiges Befehlssystem) → state/useCommandEngineHost.ts ──
  const selectionState = {
    selectedWallIds,
    selectedDrawingId,
    selectedDrawingIds,
    selectedExtrudedSolidId,
    selectedColumnId,
    selectedCeilingIds,
    selectedRoofIds,
    selectedStairIds,
    selectedRoomIds,
    groupPath,
    setSelectedWallIds,
    setSelectedCeilingIds,
    setSelectedOpeningIds,
    setSelectedStairIds,
    setSelectedRoomIds,
    setSelectedExtrudedSolidIds,
    setSelectedColumnIds,
    setSelectedRoofIds,
    setSelectedContextObjectIds,
    setSelectedSectionLineIds,
    setSelectedDrawingId,
  };
  const {
    engineRef,
    engine,
    engineView,
    commandActive,
    commandLineRef,
    setAliasOverrides,
    shortcutOverrides,
    setShortcutOverrides,
    cmdTyped,
    setCmdTyped,
  } = useCommandEngineHost({
    project,
    activeLevel,
    activeCategoryCode,
    activeLineStyleId,
    activeWallTypeId,
    visibleCodes,
    snap,
    sel: selectionState,
    setProject,
    setDraft,
    notify,
    planViewRef,
    setEditTextId,
    setEditTextMinHeightM,
  });

  // ── GUI-Werkzeug ↔ Befehls-Engine (ein Eingabe-Hub) ───────────────────────
  // Ein Klick auf ein gekoppeltes Zeichen-Werkzeug (Wand/Linie/Rechteck/Polylinie)
  // STARTET den passenden Befehl in der Engine und fokussiert das Befehlsfeld
  // („Dialog drin"). „Auswahl" beendet einen laufenden Befehl (Auswahl-Modus).
  const onSelectTool = (id: ToolId) => {
    // Erneuter Klick auf das bereits AKTIVE Werkzeug schaltet zurück auf
    // „Auswahl" (Nutzer-Wunsch) — statt das Werkzeug einfach neu zu starten.
    if (id !== "select" && id === activeTool) id = "select";
    if (id === "image") {
      // Datei-Auswahl ist async (Dateidialog) — kein Klick-Platzieren wie bei
      // den übrigen Zeichen-Werkzeugen, daher hier abgefangen statt über die
      // Befehls-Engine/`activeTool` zu laufen (s. tools/tools.ts).
      imageInputRef.current?.click();
      return;
    }
    const cmd = coupledCommandFor(id);
    if (cmd) {
      // Den gekoppelten Befehl in DERSELBEN Engine starten wie das Tippen von
      // „line" — Klick und Tippen münden in denselben Befehl. Das aktive-Tool-
      // Highlight spiegelt den laufenden Befehl (activeTool = id); toolHandlers
      // leiten Move/Pick/Confirm an die Engine (siehe oben).
      engine.start(cmd);
      setActiveTool(id);
      // Befehlsfeld fokussieren: getippte Präzisionseingabe steht sofort bereit.
      // Nach dem Render des aktiven Prompts fokussieren (nächster Tick).
      requestAnimationFrame(() => commandLineRef.current?.focus());
      return;
    }
    // „Auswahl": laufenden Befehl beenden.
    if (engine.isActive()) engine.cancel();
    setActiveTool(id);
  };

  // Ribbon-Befehl (Ändern-Gruppe u. a.): startet einen Engine-Befehl OHNE
  // eigenes Werkzeug (kein ToolId). Läuft über DIESELBE Engine wie das Tippen des
  // Befehls; das Werkzeug-Highlight fällt auf „Auswahl" zurück, das Aktiv-
  // Highlight des Ribbon-Befehls spiegelt der laufende Befehl (engineView).
  // Bewegen/Drehen/Spiegeln sind gewöhnliche Befehle ([123]); ohne Auswahl starten sie nicht
  // (Hinweis über den Engine-Host) und das Werkzeug bleibt, wie es ist.
  const onRunCommand = (name: string) => {
    if (!engine.start(name) && TRANSFORM_COMMANDS.has(name)) return;
    setActiveTool("select");
    requestAnimationFrame(() => commandLineRef.current?.focus());
  };

  // 3D-Viewport als Erstellungs-Fläche: der Viewport projiziert den Cursor auf
  // die Geschoss-Arbeitsebene und liefert einen rohen Modell-`Vec2`; wir füttern
  // ihn in DIESELBE ansichts-agnostische CommandEngine wie PlanView (move/pick).
  // Snapping/Tab-Felder/Commit laufen unverändert über den EngineHost; die neuen
  // Elemente landen auf dem aktiven Geschoss (host.context().level).
  const onWorkplanePoint = (kind: "move" | "pick", model: Vec2, mods?: EngineMods) => {
    const eng = engineRef.current;
    if (!eng?.isActive()) return;
    if (kind === "move") eng.move(model, mods);
    else eng.pick(model, mods);
  };
  const onWorkplaneConfirm = () => {
    // Rechtsklick-ohne-Drag/Doppelklick im 3D — dasselbe Verhalten wie `onToolCommit` im 2D-Plan.
    toolHandlers.onToolCommit();
  };

  // Globaler Undo/Redo-Shortcut — siehe state/useKeyboardShortcuts.ts.
  useUndoRedoShortcut(undo, redo, shortcutOverrides);

  // Esc/Enter/Backspace für das aktive Zeichenwerkzeug. Siehe
  // state/useKeyboardShortcuts.ts. Die Zifferntasten-Werkzeugwahl
  // (useToolNumberShortcuts) folgt weiter unten, NACH useGripEditing() — sie
  // braucht dessen gripDragInfoRef, um Zifferntasten während einer Griff-
  // Bearbeitung nicht als Werkzeug-Wechsel misszuverstehen.
  useActiveToolKeys(activeTool, engineRef, setActiveTool);

  // ── Editier-Griffe (Grips) des einzeln selektierten Elements ──────────────
  // Genau eine Wand ODER ein 2D-Element → dessen Eckpunkte als ziehbare Griffe.
  const selectedDrawing = useMemo(
    () => project.drawings2d.find((d) => d.id === selectedDrawingId) ?? null,
    [project.drawings2d, selectedDrawingId],
  );
  const selectedCeiling = useMemo(
    () => (project.ceilings ?? []).find((c) => c.id === selectedCeilingId) ?? null,
    [project.ceilings, selectedCeilingId],
  );
  // [68] Genau eine gewählte Baugrube (Griffe für Umriss und Sohle).
  const selectedExcavation = useMemo(() => {
    if (selectedContextObjectIds.length !== 1) return null;
    const o = (project.context ?? []).find((c) => c.id === selectedContextObjectIds[0]);
    return o && o.type === "excavation" ? o : null;
  }, [project.context, selectedContextObjectIds]);
  const selectedRoom = useMemo(
    () => (project.rooms ?? []).find((r) => r.id === selectedRoomId) ?? null,
    [project.rooms, selectedRoomId],
  );
  // Stempel-Griff des (einzeln) gewählten Raums: sein fixer Anker (Meter) + ID.
  const roomStamp = useMemo(
    () =>
      selectedRoom
        ? {
            roomId: selectedRoom.id,
            anchor: selectedRoom.stampAnchor ?? roomCentroid(selectedRoom.boundary),
          }
        : null,
    [selectedRoom],
  );
  // Editier-Griffe/Kanten-Griffe + Feld-Controller (Tab-Länge/Winkel im Vertex-Drag)
  // → state/useGripEditing.ts (Hook-Aufruf weiter unten, nach useProjectActions()).

  // Ob irgendeine löschbare Auswahl ansteht — geteilt zwischen dem Entf-
  // Tastatur-Handler unten und dem Menüpunkt „Bearbeiten > Löschen" (AppMenuBar).
  const hasSelectionToDelete = () =>
    !!(
      selectedSectionLineIds.length ||
      selectedDrawingIds.length ||
      selectedWallIds.length ||
      selectedCeilingIds.length ||
      selectedOpeningIds.length ||
      selectedStairIds.length ||
      selectedRoomIds.length ||
      selectedExtrudedSolidIds.length ||
      selectedColumnIds.length ||
      selectedRoofIds.length ||
      selectedContextObjectIds.length
    );

  // Löscht die AKTUELLE Auswahl (alle Kanäle) — geteilte Logik zwischen dem
  // Entf-Tastatur-Handler und dem Menüpunkt „Bearbeiten > Löschen".
  const deleteSelection = () => {
    // Ein Undo-Schritt für alles (Schnittlinien + Elemente), [K4] S3.
    groupChanges(() => deleteSelectionChanges());
    setSelectedDrawingIds([]);
    setSelectedWallIds([]);
    setSelectedCeilingIds([]);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedRoomIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
    setSelectedContextObjectIds([]);
    setSelectedSectionLineIds([]);
  };
  const deleteSelectionChanges = () => {
    // Schnittlinie(n): Entf löscht NUR ihre Linie (linePoints), die Ebene
    // bleibt — ADDITIV zu den übrigen Kanälen unten (nicht mehr exklusiv:
    // seit Cmd/Ctrl+A Schnittlinien zusammen mit Wänden/etc. mitselektiert,
    // würde ein frühes `return` hier die übrigen Kanäle stumm überspringen).
    if (selectedSectionLineIds.length) {
      for (const id of selectedSectionLineIds) patchLevel(id, { linePoints: undefined });
    }
    // Objekt-Sperre: gesperrte Elemente aus der Löschung ausnehmen (s.
    // `moveGrip`/`moveElementBy` im Kern, `grips.rs`, für dieselbe Prüfung
    // beim Ziehen). ExtrudedSolid/Kontext-Objekte haben kein `locked`-Feld
    // (s. deren Typdefinitionen) — bleiben ungefiltert.
    const notLocked = (kind: MemberKind, ids: string[]) =>
      ids.filter((id) => !isLocked(project, kind, id));
    const dids = new Set(notLocked("drawingIds", selectedDrawingIds));
    const wids = new Set(notLocked("wallIds", selectedWallIds));
    const cids = new Set(notLocked("ceilingIds", selectedCeilingIds));
    const oids = new Set(notLocked("openingIds", selectedOpeningIds));
    const stids = new Set(notLocked("stairIds", selectedStairIds));
    const rmids = new Set(notLocked("roomIds", selectedRoomIds));
    const exids = new Set(selectedExtrudedSolidIds);
    const colids = new Set(notLocked("columnIds", selectedColumnIds));
    const rfids = new Set(notLocked("roofIds", selectedRoofIds));
    const ctxids = new Set(selectedContextObjectIds);
    setProject(
      opsMutation((p) => [
        ...removeItems(p, "drawings2d", dids),
        ...removeItems(p, "walls", wids),
        ...removeItems(p, "ceilings", cids),
        ...removeItems(p, "roofs", rfids),
        ...removeItems(p, "stairs", stids),
        ...removeItems(p, "rooms", rmids),
        ...removeItems(p, "extrudedSolids", exids),
        ...removeItems(p, "columns", colids),
        // Öffnungen: eigene Auswahl löschen UND alle, deren Wirt (Wand, Dach, Decke [103]) entfällt.
        ...removeItems(p, "openings", (o) => oids.has(o.id) || wids.has(o.hostWallId) || (!!o.hostRoofId && rfids.has(o.hostRoofId)) || (!!o.hostCeilingId && cids.has(o.hostCeilingId))),
        ...removeItems(p, "context", ctxids),
      ]),
    );
  };

  // Tastatur im Auswahl-Werkzeug: Ctrl/Cmd+A = alles wählen, Entf/Backspace =
  // Auswahl löschen — siehe state/useKeyboardShortcuts.ts.
  useSelectAllAndDeleteShortcut({
    activeTool,
    transformActive: TRANSFORM_COMMANDS.has(engineView.commandName ?? ""),
    project,
    activeLevelId: activeLevel.id,
    shortcutOverrides,
    selectedDrawingIds,
    selectedWallIds,
    selectedCeilingIds,
    selectedOpeningIds,
    selectedStairIds,
    selectedRoomIds,
    selectedExtrudedSolidIds,
    selectedColumnIds,
    selectedRoofIds,
    selectedContextObjectIds,
    selectedSectionLineIds,
    setSelectedWallIds,
    setSelectedDrawingIds,
    setSelectedCeilingIds,
    setSelectedOpeningIds,
    setSelectedStairIds,
    setSelectedRoomIds,
    setSelectedExtrudedSolidIds,
    setSelectedColumnIds,
    setSelectedRoofIds,
    setSelectedContextObjectIds,
    setSelectedSectionLineIds,
    hasSelectionToDelete,
    deleteSelection,
  });

  // Split der gewählten 2D-Elemente an einem Punkt in mehrere Stücke (shared von
  // Ctrl+S und einem etwaigen Menü-Eintrag). Ersetzt jedes Quell-Drawing durch ≥1
  // Ergebnis; neue Elemente werden ausgewählt. Wände sind ausgenommen (no-op).
  const runSplit = (ids: string[]) => {
    if (ids.length === 0) return;
    let newIds: string[] = [];
    applyChange((p) => {
      const r = splitOps(p, ids);
      newIds = r.selectIds;
      return r.ops;
    });
    setSelectedDrawingIds(newIds);
    setSelectedWallIds([]);
  };

  // Ctrl/Cmd+S = Split, Ctrl/Cmd+J = Join der selektierten Drawing2D-Elemente —
  // siehe state/useKeyboardShortcuts.ts.
  useSplitJoinShortcut(
    selectedDrawingIds,
    engine,
    runSplit,
    setSelectedDrawingIds,
    setSelectedWallIds,
    shortcutOverrides,
  );

  // Ctrl/Cmd+Shift+U/D/I = Boolean Vereinigung/Subtraktion/Schnitt — siehe
  // state/useKeyboardShortcuts.ts. (Ctrl/Cmd+C/V-Kopieren/Einfügen folgt weiter
  // unten, nach `importDrawings`.)

  // 2D-Boolean-Operation (Union / Subtract / Intersect) auf die gewählten
  // geschlossenen Drawing2D anwenden. Reihenfolge der Auswahl = Reihenfolge in
  // `selectedDrawingIds` (für Differenz: erstes Element = Basis). Ersetzt die
  // beteiligten Quellen durch das Ergebnis und selektiert die neuen Elemente.
  // Braucht ≥2 geschlossene Flächen; sonst No-op.
  const applyBoolean = (
    op: (srcs: Drawing2D[]) => BooleanResult,
  ) => {
    const order = selectedDrawingIds;
    if (order.length < 2) return;
    const byId = new Map(project.drawings2d.map((d) => [d.id, d]));
    // In Auswahl-Reihenfolge (Basis zuerst) auflösen.
    const srcs = order
      .map((id) => byId.get(id))
      .filter((d): d is Drawing2D => d !== undefined);
    const result = op(srcs);
    if (result.replacedIds.length === 0) return; // <2 geschlossene → No-op
    const replaced = new Set(result.replacedIds);
    applyChange((p) => [...removeItems(p, "drawings2d", replaced), ...addItems("drawings2d", result.created)]);
    setSelectedDrawingIds(result.created.map((d) => d.id));
    setSelectedWallIds([]);
  };
  useBooleanOpsShortcut(selectedDrawingIds, project.drawings2d, applyBoolean, shortcutOverrides);

  // „Eigenschaften übertragen" (2D-Kontextmenü) — dasselbe Zwischenablage-
  // Muster wie beim Ebenen-Menü (`layerClipboard`), nur für den vollen
  // Aussehen-Stil eines 2D-Elements (s. `editors/matchProps.ts`).
  const copyDrawingStyle = () => {
    const d = project.drawings2d.find((x) => x.id === selectedDrawingIds[0]);
    if (d) setDrawingStyleClipboard(readDrawingStyle(d));
  };
  const pasteDrawingStyle = () => {
    if (!drawingStyleClipboard || selectedDrawingIds.length === 0) return;
    applyChange((p) => applyDrawingStyleOps(p, selectedDrawingIds, drawingStyleClipboard));
  };

  // Objekt sperren/entsperren (Kontextmenü) — wirkt auf die GANZE aktuelle
  // Auswahl (alle Elementarten, nicht nur 2D-Zeichnungen), ein Undo-Schritt.
  // Anders als der Ebenen-/Geschoss-Sperrmodus (`DisplayMode`, session-lokal)
  // ist `locked` hier ein persistiertes Feld am Element selbst, s.
  // `state/objectLock.ts`.
  const selectionLockMembers: Partial<Record<MemberKind, string[]>> = {
    wallIds: selectedWallIds,
    drawingIds: selectedDrawingIds,
    ceilingIds: selectedCeilingIds,
    roomIds: selectedRoomIds,
    stairIds: selectedStairIds,
    columnIds: selectedColumnIds,
    roofIds: selectedRoofIds,
    openingIds: selectedOpeningIds,
  };
  const selectionLockIds = (
    Object.entries(selectionLockMembers) as [MemberKind, string[]][]
  ).flatMap(([kind, ids]) => ids.map((id) => [kind, id] as const));
  const selectionAllLocked =
    selectionLockIds.length > 0 &&
    selectionLockIds.every(([kind, id]) => isLocked(project, kind, id));
  const toggleSelectionLock = () => {
    if (selectionLockIds.length === 0) return;
    applyChange((p) => lockMembersOps(p, selectionLockMembers, !selectionAllLocked));
  };

  // Ebene(n) der Auswahl ausblenden / isolieren (Kontextmenü). Nur bei geöffnetem
  // Menü berechnet — bei Kataster-Importen (~10^5 Zeichnungen) nicht bei jedem Render.
  const selectionLayerCodes = menu
    ? selectionCategoryCodes(project, {
        wallIds: selectedWallIds,
        drawingIds: selectedDrawingIds,
        ceilingIds: selectedCeilingIds,
        roomIds: selectedRoomIds,
        stairIds: selectedStairIds,
        columnIds: selectedColumnIds,
        roofIds: selectedRoofIds,
        openingIds: selectedOpeningIds,
      })
    : [];
  const hideSelectionLayers = () => {
    if (selectionLayerCodes.length === 0) return;
    const codes = new Set(selectionLayerCodes);
    applyChange((p) => fieldOps(p, "layers", setCategoriesVisible(p.layers, codes, false)));
  };
  const isolateSelectionLayers = () => {
    if (selectionLayerCodes.length === 0) return;
    const codes = new Set(selectionLayerCodes);
    applyChange((p) => fieldOps(p, "layers", isolateCategories(p.layers, codes)));
  };

  // „Nicht drucken"/„Drucken" (Kontextmenü) — nur `Drawing2D` kennt
  // `noPrint` (Nutzer-Wunsch „Kein 'nicht druckend'-Flag im Modell"), daher
  // simpler als die Sperre oben: direkt über `selectedDrawingIds`.
  const selectionAllNoPrint =
    selectedDrawingIds.length > 0 &&
    selectedDrawingIds.every((id) => project.drawings2d.find((d) => d.id === id)?.noPrint);
  const toggleSelectionNoPrint = () => {
    if (selectedDrawingIds.length === 0) return;
    const next = !selectionAllNoPrint;
    applyChange((p) => patchItems(p, "drawings2d", selectedDrawingIds, (d) => ({ ...d, noPrint: next })));
  };

  // „Bemassung lösen" ([38]): gewählte Bemassungen mit Bezügen auf Modell-Elemente.
  const attachedDimensionIds = selectedDrawingIds.filter((id) => {
    const g = project.drawings2d.find((d) => d.id === id)?.geom;
    return g?.shape === "dimension" && !!g.refs?.some(Boolean);
  });
  const detachDimensions = () => {
    if (attachedDimensionIds.length) applyChange((p) => cmdMutation({ cmd: "dimdetach", ids: attachedDimensionIds }).toOps(p));
  };

  // Ctrl/Cmd+G / Ctrl/Cmd+Shift+G = Gruppieren/Auflösen (Vectorworks-artig,
  // s. state/groupActions.ts). `applyGroupSelection` setzt nach dem Gruppieren/
  // Auflösen alle betroffenen Auswahl-Kanäle auf einen Schlag.
  const applyGroupSelection = (mem: GroupMembership, groupIds: string[]) => {
    setSelectedWallIds(mem.wallIds);
    setSelectedDrawingIds(mem.drawingIds);
    setSelectedCeilingIds(mem.ceilingIds);
    setSelectedOpeningIds(mem.openingIds);
    setSelectedStairIds(mem.stairIds);
    setSelectedRoomIds(mem.roomIds);
    setSelectedColumnIds(mem.columnIds);
    setSelectedRoofIds(mem.roofIds);
    setSelectedGroupIds(groupIds);
  };
  useGroupShortcut(
    project,
    applyChange,
    {
      wallIds: selectedWallIds,
      drawingIds: selectedDrawingIds,
      ceilingIds: selectedCeilingIds,
      roomIds: selectedRoomIds,
      stairIds: selectedStairIds,
      columnIds: selectedColumnIds,
      roofIds: selectedRoofIds,
      openingIds: selectedOpeningIds,
    },
    selectedGroupIds,
    applyGroupSelection,
    shortcutOverrides,
  );

  // Doppelklick auf ein gruppiertes Element → Gruppe betreten (Isolation):
  // alles ausserhalb wird gedimmt/gesperrt gerendert (s. viewportContent.tsx/
  // PlanView „greyed"-Pass) und lässt sich nicht mehr anwählen (s.
  // useMouseSelectionHandlers.ts). Auswahl wird geleert, damit man sauber
  // "in" der Gruppe startet.
  const onEnterGroup = (hit: {
    wallId?: string;
    drawingId?: string;
    ceilingId?: string;
    roomId?: string;
    stairId?: string;
    columnId?: string;
    roofId?: string;
  }): boolean => {
    const kind = hit.wallId
      ? "wallIds"
      : hit.drawingId
        ? "drawingIds"
        : hit.ceilingId
          ? "ceilingIds"
          : hit.roomId
            ? "roomIds"
            : hit.stairId
              ? "stairIds"
              : hit.columnId
                ? "columnIds"
                : hit.roofId
                  ? "roofIds"
                  : null;
    const id = hit.wallId ?? hit.drawingId ?? hit.ceilingId ?? hit.roomId ?? hit.stairId ?? hit.columnId ?? hit.roofId;
    if (!kind || !id) return false;
    const gid = containingGroupId(project, kind, id, groupPath);
    if (!gid) return false;
    setGroupPath([...groupPath, gid]);
    applyGroupSelection({ ...EMPTY_MEMBERSHIP }, []);
    return true;
  };
  // "Gruppe verlassen"-Knopf (oben links im Grundriss): verlässt genau EIN
  // Isolations-Level (Vectorworks-Verhalten bei verschachtelten Gruppen).
  const onLeaveGroup = () => {
    setGroupPath(groupPath.slice(0, -1));
    applyGroupSelection({ ...EMPTY_MEMBERSHIP }, []);
  };

  // Alt+Klick im Grundriss = Segment löschen (Schere): PlanView meldet das
  // getroffene Drawing2D + den Modellpunkt; App ermittelt daraus die nächst-
  // gelegene Kante (Kern `cmd_split.rs`) und entfernt sie. Geschlossene Form →
  // offene Polylinie; bleiben <2 Punkte übrig, wird das Element gelöscht.
  const onSegmentCut = (drawingId: string, model: Vec2) => {
    let removed = false;
    applyChange((p) => {
      const r = cutSegmentOps(p, drawingId, model);
      removed = r.removed;
      return r.ops;
    });
    if (removed) setSelectedDrawingIds([]);
  };

  // Transformations-Shortcuts (m/s/d, U/I/O/P-Modusleiste, „q" Messen) — siehe
  // state/useKeyboardShortcuts.ts.
  useTransformShortcuts(
    activeTool,
    selectedWallIds.length > 0 ||
      !!selectedDrawingId ||
      selectedDrawingIds.length > 0 ||
      !!selectedExtrudedSolidId ||
      !!selectedColumnId ||
      selectedCeilingIds.length > 0 ||
      selectedRoofIds.length > 0 ||
      selectedStairIds.length > 0 ||
      selectedRoomIds.length > 0,
    engine,
    (id) => onCommandOption(id),
    onRunCommand,
    shortcutOverrides,
  );

  // ── Projekt-Mutationen (aus dem Store-Slice) ─────────────────────────────
  // Sämtliche immutablen Projekt-Mutationen + Ressourcen-Typ-CRUD (Wand-/
  // Decken-/Dach-/Tür-/Fenster-/Treppentyp) in useProjectActions() gebündelt,
  // siehe dort.
  const {
    toggleLevelVisible,
    toggleCategoryVisible,
    addFloor,
    addDrawing,
    addSection,
    addElevation,
    addCategory,
    patchCategory,
    addSubCategory,
    duplicateCategory,
    deleteCategory,
    assignWallCategory,
    snapshotLayerVisibility,
    applyLayerVisibility,
    snapshotDrawingVisibility,
    applyDrawingVisibility,
    patchLevel,
    duplicateLevel,
    deleteLevel,
    patchComponent,
    addComponent,
    deleteComponent,
    patchHatch,
    addHatch,
    deleteHatch,
    patchLineStyle,
    addLineStyle,
    deleteLineStyle,
    patchTextStyle,
    addTextStyle,
    deleteTextStyle,
    addPen,
    renamePen,
    deletePen,
    addPenSet,
    renamePenSet,
    deletePenSet,
    setActivePenSet,
    patchPenSetColor,
    patchPenSetWeight,
    seedStandardPenSet,
    loadStandards,
    updateStandards,
    addCustomPalette,
    renameCustomPalette,
    deleteCustomPalette,
    addColorToCustomPalette,
    removeColorFromCustomPalette,
    setCustomPaletteVisible,
    setBuiltinPaletteVisible,
    insertDrawingPoint,
    deleteDrawingPoint,
    setPolylineVertexType,
    patchWallType,
    setOverrideRules,
    patchCeilingType,
    addWallType,
    deleteWallType,
    addCeilingType,
    deleteCeilingType,
    patchRoofType,
    addRoofType,
    deleteRoofType,
    addDoorType,
    patchDoorType,
    deleteDoorType,
    addWindowType,
    patchWindowType,
    deleteWindowType,
    saveOpeningStyle,
    addStairType,
    patchStairType,
    deleteStairType,
    importLineStyles,
    importHatches,
    addContextObjectsAndFit,
    fitToContextObjects,
    removeContextObject,
    removeContextObjects,
    generateTerrain,
    patchContextObject,
    moveGripOf,
    moveElementByOf,
    moveEdgeOf,
    commitTransformOn,
    setElementColor,
    setElementWeight,
    setElementFill,
    setElementFillColor,
    setElementForeground,
    setElementBackground,
    updateDrawing2D,
    reorderDrawings,
    reorderDrawingLevels,
    resizeElement,
    updateWall,
    setWallThickness,
    updateOpening,
    moveCeilingGrip,
    moveExcavationGrip,
    moveExcavationEdge,
    moveCeilingBy,
    moveCeilingEdge,
    updateCeiling,
    setCeilingThickness,
    updateStair,
    moveStairBy,
    updateRoom,
    moveRoomBy,
    moveRoomGrip,
    moveRoomEdge,
    moveRoomStamp,
    setRoomStampDoc,
    setRoomStamp,
  } = useProjectActions(applyChange, notify, planViewRef);

  // IFC-Import: erst die Wahl Mesh/Bauteile (`IfcImportDialog`), dann liest das Format-Modul (Web-Worker) und der
  // Kern übernimmt [B3] Kontext-Meshes oder [B4] echte Bauteile als EINEN Undo-Schritt ([K4] S4, `importIfc`).
  const [pendingIfc, setPendingIfc] = useState<File | null>(null);
  const importIfcFile = (f: File) => setPendingIfc(f);
  const runIfcImport = (f: File, mode: IfcImportMode) => {
    const elements = mode === "elements";
    void f
      .arrayBuffer()
      .then((buf) => readIfcFlat(new Uint8Array(buf), elements))
      .then((flat) => {
        const r = getState().commitImport((doc, base, now) => doc.importIfc(base, flat, { fileName: f.name, elements }, now), "history.import.ifc");
        if (!r) return;
        const report = r.report;
        if (elements && r.summary) {
          const bounds = addedItems(r.ops, "walls").flatMap((w) => [(w as Wall).start, (w as Wall).end]);
          if (bounds.length) planViewRef.current?.fitBounds(bounds);
          const s = r.summary;
          const empty = s.walls + s.ceilings + s.columns + s.rooms + s.meshes === 0;
          notify(formatIfcElementsSummary(s, report, t), empty || report.truncated ? "warning" : "info");
          return;
        }
        fitToContextObjects(addedItems(r.ops, "context") as ContextObject[]);
        const warn = r.contextObjects === 0 || report.truncated || report.productsWithoutGeometry > 0;
        notify(formatIfcReport(report, t), warn ? "warning" : "info");
      })
      .catch((err) =>
        notify(`${t("ifc.import.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error"),
      );
  };
  /** Datei aus Import-Dialog oder Drag & Drop: IFC direkt, sonst DXF/DWG-Dialog. */
  const openImportForAnyFile = (f: File) => {
    if (isMeshFile(f.name)) return requestMeshImport(f);
    if (isPointCloudFile(f.name)) return requestPointCloudImport(f);
    if (/\.ifc$/i.test(f.name)) importIfcFile(f);
    else openImportForFile(f);
  };

  // 2D-Griff-Editieren (Eckpunkt-/Kanten-Griffe + Feld-Controller) der aktuellen
  // Auswahl — siehe state/useGripEditing.ts.
  // Schnitt-/Ansichts-Blatt: geschnittene (bzw. in der Ansicht sichtbare)
  // Wände/Decken lassen sich dort waagrecht entlang der Linie ziehen (s.
  // useGripEditing `sheet`).
  const sectionSheet = useMemo(() => {
    if (activeLevel.kind !== "section" && activeLevel.kind !== "elevation") return null;
    const plane = sectionPlaneFromLevel(activeLevel);
    if (!plane) return null;
    const u = sectionUAxisModel(plane);
    const len = Math.hypot(u.x, u.y) || 1;
    return { levelId: activeLevel.id, uAxis: { x: u.x / len, y: u.y / len } };
  }, [activeLevel]);

  const {
    grips,
    gripHandleLines,
    edgeGrips,
    gripHandlers,
    gripEdit,
    gripEditFields,
    cycleGripEditField,
    submitGripEditValue,
    closeGripEditField,
    edgeEdit,
    edgeEditFields,
    cycleEdgeEditField,
    submitEdgeEditValue,
    closeEdgeEditField,
    gripDragInfoRef,
    edgeDragInfoRef,
  } = useGripEditing({
    project,
    selectedDrawing,
    selectedCeiling,
    selectedExcavation,
    selectedRoom,
    selectedOpeningId,
    selectedStairId,
    selectedRoomId,
    selectedCeilingId,
    selectedDrawingId,
    selectedWallId,
    selectedWallIds,
    selectedDrawingIds,
    levelId: activeLevel.id,
    modelEditable: activeLevel.kind !== "section" && activeLevel.kind !== "elevation",
    sheet: sectionSheet,
    visibleCodes,
    scaleDenominator: planScale,
    snap,
    setDraft,
    snapFor,
    engineRef,
    commandLineRef,
    updateOpening,
    updateWall,
    moveStairBy,
    moveRoomGrip,
    moveCeilingGrip,
    moveExcavationGrip,
    moveExcavationEdge,
    moveGripOf,
    moveRoomEdge,
    moveCeilingEdge,
    moveEdgeOf,
    moveRoomBy,
    moveCeilingBy,
    moveElementByOf,
    groupChanges,
  });

  // Nummern-Shortcuts für Zeichenwerkzeuge (Vectorworks-Stil): 1 Text, 2 Linie,
  // 3 Kreis, 4 Rechteck, 5 Polylinie, 6 Wand, 7 Decke, 8 Fenster, 9 Türe, 0 Raum.
  // Siehe state/useKeyboardShortcuts.ts. Braucht gripDragInfoRef/edgeDragInfoRef
  // (s. o.), daher erst hier nach useGripEditing() registriert.
  useToolNumberShortcuts(
    onSelectTool,
    activeLevel.kind === "floor",
    engineRef,
    shortcutOverrides,
    gripDragInfoRef,
    edgeDragInfoRef,
  );

  // Ctrl/Cmd+C / Ctrl/Cmd+V = Bauteile kopieren/einfügen (alle 9 Auswahl-Kanäle,
  // nicht nur 2D-Zeichenelemente) — siehe state/useKeyboardShortcuts.ts.
  useElementClipboardShortcut(
    {
      wallIds: selectedWallIds,
      drawingIds: selectedDrawingIds,
      ceilingIds: selectedCeilingIds,
      roofIds: selectedRoofIds,
      openingIds: selectedOpeningIds,
      stairIds: selectedStairIds,
      roomIds: selectedRoomIds,
      extrudedSolidIds: selectedExtrudedSolidIds,
      columnIds: selectedColumnIds,
    },
    elementClipboard,
    setElementClipboard,
    activeLevelId,
    project,
    applyChange,
    {
      wallIds: setSelectedWallIds,
      drawingIds: setSelectedDrawingIds,
      ceilingIds: setSelectedCeilingIds,
      roofIds: setSelectedRoofIds,
      openingIds: setSelectedOpeningIds,
      stairIds: setSelectedStairIds,
      roomIds: setSelectedRoomIds,
      extrudedSolidIds: setSelectedExtrudedSolidIds,
      columnIds: setSelectedColumnIds,
    },
    shortcutOverrides,
  );

  // Projektdatei-I/O (Speichern/Öffnen/Lock), Schnellexport (CSV/IFC/OBJ/STL)
  // und die Ausführung eines bestätigten DXF/DWG-Imports — gebündelt in
  // useProjectFileActions(), siehe dort.
  const {
    recovery,
    onRecoverRestore,
    onRecoverDiscard,
    onRecoverLater,
    projectFileInputRef,
    projectTemplateFileInputRef,
    lockConflict,
    setLockConflict,
    pendingDiscard,
    setPendingDiscard,
    openImportForFile,
    loadImportLayout,
    setImportPdfOptions,
    onSaveProject,
    onNewProject,
    onNewProjectFromSample,
    onNewProjectFromComplexSample,
    onNewProjectFromTemplate,
    onProjectTemplateFileChosen,
    applyOpenedProjectFile,
    projectFileName,
    runExport,
    onExportSchedule,
    onExportIfc,
    onExportObj,
    onExportStl,
    onExportGlb,
    onExportStep,
    onOpenProject,
    openProjectAtPath,
    onProjectFileChosen,
    runImport,
  } = useProjectFileActions(
    project,
    setImportState,
    setExportSaveFormat,
    activeCategoryCode,
    setActiveLevelId,
    planViewRef,
  );

  // Text-Ziel der Oberleisten-Text-Gruppe: der Stempel-Text des (einzeln)
  // gewählten Raums. Ohne aktive Editor-Auswahl wirkt Formatierung auf das ganze
  // Doc (range: null). Ist kein Raum gewählt → null (Controls setzen nur
  // Defaults). Der Setter schreibt live in den Store.
  // Store-Aktionen mit stabiler Identität ([121]): sonst wäre `textTarget` je Render neu.
  const textActions = useEventBundle({ setRoomStampDoc, updateDrawing2D });
  const textTarget = useMemo(() => {
    if (selectedRoom) {
      return {
        doc: selectedRoom.stampDoc ?? docFromText(selectedRoom.name),
        range: null,
        apply: (doc: RichTextDoc) => textActions.setRoomStampDoc(selectedRoom.id, doc),
      };
    }
    // Selektierter freier Text/Textspalte: die Oberleisten-Formatier-Gruppe wirkt
    // auf Schriftfamilie/fett/kursiv/Farbe des ganzen Texts. Die GRÖSSE bleibt
    // bewusst über die Modell-Höhe (Meter, height) geführt — nicht über sizePt,
    // damit der Text im Massstab bleibt (Punkt-Grössen wären massstabslos).
    if (selectedDrawingId) {
      const d = project.drawings2d.find((x) => x.id === selectedDrawingId);
      if (d && d.geom.shape === "text") {
        const g = d.geom;
        // Trägt das Element bereits ein reiches Doc (Doppelklick-Editor), wirkt
        // die Oberleiste per Bereichs-Operation (toggleMark/applyMark) DARAUF —
        // Mischformatierung anderer Runs bleibt erhalten. Ohne Doc (Alt-Element)
        // bleibt das bisherige Uniform-Verhalten (ein `marks`-Objekt fürs Ganze).
        const doc = g.doc ?? docFromText(g.text, g.marks ?? {});
        return {
          doc,
          range: null,
          apply: (newDoc: RichTextDoc) => {
            const runMarks = newDoc.paragraphs.flatMap((p) => p.runs)[0]?.marks ?? {};
            const marks = { ...runMarks };
            delete marks.sizePt; // Grösse folgt der Modell-Höhe, nicht dem pt-Wert.
            const patch = g.doc
              ? { doc: newDoc, text: plainText(newDoc), marks }
              : { text: plainText(newDoc), marks };
            textActions.updateDrawing2D(d.id, { geom: { ...g, ...patch } });
          },
        };
      }
    }
    return null;
  }, [selectedRoom, textActions, selectedDrawingId, project.drawings2d]);

  // ── 3D-Editier-Griffe (direkt im Viewport3D) → state/useGrip3dEditing.ts ───
  const {
    edit3dWalls,
    edit3dDrawings,
    edit3dCeilings,
    edit3dRoofs,
    grip3dEdit,
    setGrip3dEdit,
    last3dDragRef,
    onEdit3dVertex,
    onEdit3dBody,
    onEdit3dEdge,
    onEdit3dRoofPitch,
    onEdit3dWallTop,
    onEdit3dEnd,
    cycleGrip3dEditField,
    cancelGrip3dEdit,
    submitGrip3dEditValue,
  } = useGrip3dEditing({
    project,
    levelId: activeLevel.id,
    visibleCodes,
    snap,
    setDraft,
    undo,
    commandLineRef,
    selectedWallIds,
    selectedDrawingIds,
    selectedCeilingIds,
    selectedRoofIds,
    updateRoof,
    moveRoofGrip,
    moveRoofBy,
    moveCeilingGrip,
    moveCeilingBy,
    moveCeilingEdge,
    moveGripOf,
    moveElementByOf,
    updateWall,
  });

  // ── Selektions-Attribut-Kontrakt (Attributes-/Object-Info-Paletten) ───────
  // Normalisierte, effektiv aufgelöste Sicht auf das erste selektierte Element.
  const selection = useMemo((): Selection | null => {
    return deriveSelection(
      project,
      selectedWallIds,
      selectedDrawingId,
      selectedCeilingId,
      selectedOpeningId,
      selectedStairId,
      selectedRoomId,
      selectedExtrudedSolidId,
      selectedColumnId,
      selectedRoofId,
      selectedContextObjectIds.length === 1 ? selectedContextObjectIds[0] : null,
    );
  }, [
      project,
      selectedWallIds,
      selectedDrawingId,
      selectedCeilingId,
      selectedOpeningId,
      selectedStairId,
      selectedRoomId,
      selectedExtrudedSolidId,
      selectedColumnId,
      selectedRoofId,
      selectedContextObjectIds,
    ],
  );

  // Gewählte Schnitt-/Ansichtslinie (DrawingLevel) — separat von `selection`, da
  // eine Schnittlinie KEIN Projekt-Bauteil ist. Speist die Schnittlinien-Sektion
  // des Object-Info-Panels.
  // Ohne gewählte Linie, aber mit aktivem Schnitt/aktiver Ansicht: deren
  // Einstellungen (Tiefe, verdeckte Kanten, Grundriss-Unterlage …) direkt im
  // Leerzustand zeigen — man arbeitet ja gerade IN diesem Schnitt.
  const sectionLineId =
    selectedSectionLineId ??
    (activeLevel.kind === "section" || activeLevel.kind === "elevation" ? activeLevel.id : null);
  const sectionLine = useMemo(
    () =>
      sectionLineId
        ? project.drawingLevels.find(
            (z) =>
              z.id === sectionLineId &&
              (z.kind === "section" || z.kind === "elevation"),
          ) ?? null
        : null,
    [project.drawingLevels, sectionLineId],
  );

  // Abgeleitete 3D-Schnittebene der gebundenen Schnittlinie (world point+normal
  // via sectionPlaneFromLevel) — speist Viewport3D/Wasm3DViewport. Fehlt die
  // Linie (gelöscht/ohne linePoints), liefert der Helfer null → kein Schnitt.
  const section3dPlane = useMemo(() => {
    if (!section3dCutId) return null;
    const lvl = project.drawingLevels.find(
      (z) =>
        z.id === section3dCutId &&
        (z.kind === "section" || z.kind === "elevation"),
    );
    return lvl ? sectionPlaneFromLevel(lvl) : null;
  }, [project.drawingLevels, section3dCutId]);

  // Aus einem Schnitt ins 3D ([115]): der Live-Schnitt folgt der Schnittlinie dieses Schnitts (einmal
  // beim Wechsel; im 3D lässt er sich wie sonst aufheben).
  const sectionLevelIn3d = activeLevel.kind === "section" && viewType === "perspektive" ? activeLevel.id : null;
  useEffect(() => {
    if (sectionLevelIn3d) setSection3dCutId(sectionLevelIn3d);
  }, [sectionLevelIn3d, setSection3dCutId]);

  // Bindet den 3D-Live-Schnitt an eine Schnittlinie (Toggle im Objekt-Info).
  const onToggleSection3dCut = useCallback(
    (id: string) => setSection3dCutId((cur) => (cur === id ? null : id)),
    [],
  );

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

  // ── Ausschnitt-Anwahl: „bleibt bis zur Abweichung" (DOSSIER A2) ───────────
  // Sobald ein Ausschnitt angewählt ist, vergleicht dieser Effekt bei JEDER
  // Änderung einer ERFASSTEN Grösse (Ansicht/Kamera/Massstab/Detail/Geschoss +
  // Ebenen-/Zeichnungssichtbarkeit + aktive Overrides) den Live-Zustand gegen
  // den gespeicherten Kernzustand (pure `snapshotMatchesLiveState`). Weicht auch
  // nur EIN Feld ab → Auswahl löschen (Footer verschwindet). Der Effekt reagiert
  // NUR auf die snapshot-relevanten Projekt-Teile (layers/drawingLevels/
  // overrideRules), NICHT auf `project` als Ganzes — eine Wand verschieben o. Ä.
  // lässt die Auswahl unberührt.
  useEffect(() => {
    if (!selectedViewSnapshotId) return;
    const snap = (project.viewSnapshots ?? []).find(
      (s) => s.id === selectedViewSnapshotId,
    );
    if (!snap) {
      setSelectedViewSnapshotId(null);
      return;
    }
    const live: ViewSnapshotState = {
      viewType,
      view3d,
      fov,
      scaleDenominator,
      detail,
      activeLevelId,
      layerVisibility: snapshotLayerVisibility(),
      drawingVisibility: snapshotDrawingVisibility(),
      enabledOverrideRuleIds: (project.overrideRules ?? [])
        .filter((r) => r.enabled)
        .map((r) => r.id),
    };
    if (!snapshotMatchesLiveState(readViewSnapshot(snap), live)) {
      setSelectedViewSnapshotId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedViewSnapshotId,
    viewType,
    view3d,
    fov,
    scaleDenominator,
    detail,
    activeLevelId,
    project.viewSnapshots,
    project.layers,
    project.drawingLevels,
    project.overrideRules,
  ]);

  // ── Dock-/Float-Handler (aus dem Layout-Slice) ────────────────────────────
  // Die Layout-Mutationen (Resize/Reorder/Stapeln/Lösen/Float) liegen jetzt im
  // layoutSlice. App liest sie als Store-Actions und verdrahtet sie unverändert
  // mit dem (transienten) Drag-Controller und den Panels.
  const resizeDock = useStore((s) => s.resizeDock);
  const resizeGroups = useStore((s) => s.resizeGroups);
  const activateTab = useStore((s) => s.activateTab);
  const joinGroup = useStore((s) => s.joinGroup);
  const newGroup = useStore((s) => s.newGroup);
  const dropFloat = useStore((s) => s.dropFloat);
  const focusFloat = useStore((s) => s.focusFloat);
  const moveFloat = useStore((s) => s.moveFloat);
  const resizeFloat = useStore((s) => s.resizeFloat);
  const closeFloat = useStore((s) => s.closeFloat);
  const redockFloat = useStore((s) => s.redockFloat);
  const dockFloatTo = useStore((s) => s.dockFloatTo);

  // Tab-Drag-Steuerung (Reorder/Einreihen/Stapeln/Lösen) + Float-Titel-Drag
  // über Rand-Andockzonen — siehe state/useDockDragState.ts.
  const {
    drag,
    startTabDrag,
    onFloatTitleDrop,
    onFloatTitleDrag,
    leftHasTabs,
    rightHasTabs,
    dragActive,
    activeZone,
  } = useDockDragState({
    layout,
    activateTab,
    joinGroup,
    newGroup,
    dropFloat,
    dockFloatTo,
  });

  // Ansichtsvorlagen ([34]): Ressourcen-Handler + Abgleich der verknüpften Vorlage der aktiven Ansicht.
  const viewTemplateHandlers = useViewTemplateHandlers({
    project,
    applyChange,
    groupChanges,
    activeLevel,
    detail,
    setDetail,
    scaleDenominator,
    setScaleDenominator,
    snapshotLayerVisibility,
    applyLayerVisibility,
    mono: planColorMode === "mono",
    setMono: (m) => setPlanColorMode(m ? "mono" : "color"),
    displayMode: modeFor(BUILTIN_PANEL_IDS.drawingLevels),
    setDisplayMode: (m) => setModeFor(BUILTIN_PANEL_IDS.drawingLevels, m),
    planViewRef,
  });

  // Handler-Bündel für das schwebende Ressourcen-Fenster (ResourceManager).
  const resourceHandlers: ResourceManagerHandlers = {
    ...viewTemplateHandlers,
    onPatchComponent: patchComponent,
    onPatchWallType: patchWallType,
    onAddWallType: addWallType,
    onDeleteWallType: deleteWallType,
    onPatchCeilingType: patchCeilingType,
    onAddCeilingType: addCeilingType,
    onDeleteCeilingType: deleteCeilingType,
    onPatchRoofType: patchRoofType,
    onAddRoofType: addRoofType,
    onDeleteRoofType: deleteRoofType,
    onAddDoorType: addDoorType,
    onPatchDoorType: patchDoorType,
    onDeleteDoorType: deleteDoorType,
    onAddWindowType: addWindowType,
    onPatchWindowType: patchWindowType,
    onDeleteWindowType: deleteWindowType,
    onAddStairType: addStairType,
    onPatchStairType: patchStairType,
    onDeleteStairType: deleteStairType,
    onAddComponent: addComponent,
    onDeleteComponent: deleteComponent,
    onPatchHatch: patchHatch,
    onAddHatch: addHatch,
    onDeleteHatch: deleteHatch,
    onPatchLineStyle: patchLineStyle,
    onAddLineStyle: addLineStyle,
    onDeleteLineStyle: deleteLineStyle,
    onImportLineStyles: importLineStyles,
    onImportHatches: importHatches,
    onPatchTextStyle: patchTextStyle,
    onAddTextStyle: addTextStyle,
    onDeleteTextStyle: deleteTextStyle,
    onSetOverrideRules: setOverrideRules,
    onAddPen: addPen,
    onRenamePen: renamePen,
    onDeletePen: deletePen,
    onAddPenSet: addPenSet,
    onRenamePenSet: renamePenSet,
    onDeletePenSet: deletePenSet,
    onSetActivePenSet: setActivePenSet,
    onPatchPenSetColor: patchPenSetColor,
    onPatchPenSetWeight: patchPenSetWeight,
    onSeedStandardPenSet: seedStandardPenSet,
    onLoadStandards: loadStandards,
    onUpdateStandards: updateStandards,
    onAddCustomPalette: addCustomPalette,
    onRenameCustomPalette: renameCustomPalette,
    onDeleteCustomPalette: deleteCustomPalette,
    onRemoveColorFromCustomPalette: removeColorFromCustomPalette,
    onSetCustomPaletteVisible: setCustomPaletteVisible,
    onSetBuiltinPaletteVisible: setBuiltinPaletteVisible,
    onAddColorToCustomPalette: addColorToCustomPalette,
  };

  // Ressourcen-Manager als eigenes natives Fenster (Tauri) statt Overlay im
  // Hauptfenster — hält es (falls offen) synchron zum Projekt, wendet dessen
  // Befehle auf die ECHTEN Handler oben an (siehe native/resourceWindow.ts).
  // No-op ausserhalb von Tauri.
  useResourceWindowHost(project, resourceHandlers);
  // Öffnet die Ressourcen: unter Tauri das native Zweitfenster, sonst (reiner
  // Browser, kein OS-Fenster-Konzept) das bisherige schwebende Overlay.
  const openResources = (tab?: ResourceTabId) => {
    if (isTauriRuntime()) {
      void openResourceWindowNative(tab);
    } else {
      if (tab) setResourcesTab(tab);
      setResourcesOpen(true);
    }
  };
  const toggleResources = () => {
    if (isTauriRuntime()) {
      void openResourceWindowNative();
    } else {
      setResourcesOpen((v) => !v);
    }
  };

  // ── Layout-Blatt (DOSSIER A3) → state/useSheetPane.ts ─────────────────────
  const sheetPane = useSheetPane({
    project,
    activeLayoutId,
    setActiveLayoutId,
    activeLevelId,
    setActiveLevelId,
    applyChange,
  });

  // ── Effektive Darstellung für die Hauptansicht → state/useDisplayResolvers.ts ──
  const { floorDisplay, categoryDisplay, displayKey, drawingLevelsMode } = useDisplayResolvers({
    project,
    activeLevelId,
    activeCategoryCode,
  });

  // ── Ableitungen für Oberleiste + Status-Leiste ────────────────────────────
  // Eine zoom-/cursor-fähige Plan-Ansicht ist nur im Grundriss eines Geschosses
  // aktiv. Sonst sind Cursor/Zoom bedeutungslos (PlanView ist nicht montiert →
  // das Handle ist null, Aktionen sind No-Ops).
  const planActive = activeLevel.kind === "floor" && viewType === "grundriss";
  // 3D gibt es aus Geschoss, Schnitt und Ansicht ([115]); eine freie Zeichnung hat keine Höhe.
  const has3dView = activeLevel.kind !== "drawing";
  // Start-Protokoll: war der letzte Lauf unsauber beendet, kurz darauf hinweisen (Autosave sichert
  // die Daten); beim Schliessen die Sitzung als sauber markieren.
  useEffect(() => {
    const r = markSessionStart();
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
  useSettingsWindowHost(
    {
      themeMode,
      marqueeColor,
      snapColor,
      referenceElevationMasl: project.referenceElevationMasl,
      scaleLineWeights: project.scaleLineWeights === true,
      offline,
      aiAccess,
      layout,
    },
    {
      onThemeModeChange: setThemeMode,
      onMarqueeColorChange: setMarqueeColor,
      onSnapColorChange: setSnapColor,
      onReferenceElevationChange: (n) => applyChange((p) => setFieldIfChanged(p, "referenceElevationMasl", n)),
      onScaleLineWeightsChange: setScaleLineWeights,
      onOfflineChange,
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

  // Ebeneneinstellungen als eigenes natives Fenster (DOSSIER-Rhino-Referenz)
  // — ersetzt unter Tauri den InlineEditor-Popover, s. native/layerSettingsWindow.ts.
  useLayerSettingsWindowHost(project, nativeLayerSettingsCode, patchCategory);
  const openLayerSettings = (code: string, x: number, y: number) => {
    if (isTauriRuntime()) {
      setNativeLayerSettingsCode(code);
      void openLayerSettingsWindowNative(code);
    } else {
      setEditor({ kind: "layer", code, x, y });
    }
  };

  // Standort-Import als eigenes natives Fenster — s. native/contextImportWindow.ts.
  useContextImportWindowHost(project.geoAnchor, {
    onImport: (objs) => addContextObjectsAndFit(objs as ContextObject[]),
    onSetGeoAnchor: (anchor) => applyChange((p) => setFieldIfChanged(p, "geoAnchor", anchor)),
  });

  // Zeichnungsebenen-Manager als eigenes natives Fenster (DOSSIER-Rhino-
  // Referenz) — additiv NEBEN dem bestehenden Dock-Panel, siehe
  // native/drawingLevelsWindow.ts Kopfkommentar (Rechtsklick-Kontextmenü
  // bewusst nicht mitgenommen).
  useDrawingLevelsWindowHost(
    {
      drawingLevels: project.drawingLevels.filter((z) => !z.layoutId),
      activeLevelId,
      displayMode: drawingLevelsMode,
    },
    {
      onSelectLevel: setActiveLevelId,
      onToggleLevel: toggleLevelVisible,
      onAddFloor: addFloor,
      onAddSection: addSection,
      onAddElevation: addElevation,
      onAddDrawing: addDrawing,
      onSetDisplayMode: (mode) => setModeFor(BUILTIN_PANEL_IDS.drawingLevels, mode),
    },
  );
  // Übernimmt ein Zeichenwerkzeug ODER eine laufende Transformation die linke
  // Maustaste der Plan-Ansicht? Dann liegt der Pointer-Input beim Tool/Transform
  // (statt Auswahl/Marquee), und die Editier-Griffe sind ausgeblendet.
  // Ein laufender Befehl übernimmt ebenfalls die linke Maustaste der Plan-Ansicht
  // (über denselben toolHandlers-Pfad) — daher hier mit einbeziehen.
  const toolInputActive =
    activeTool !== "select" || commandActive;

  // Tatsächlich (noch) existierende gewählte Wände — IDs, die es nicht mehr gibt
  // (z. B. nach Löschen/Geschosswechsel), fallen heraus.
  const selectedWalls = useMemo(() => {
    const ids = new Set(selectedWallIds);
    return project.walls.filter((w) => ids.has(w.id));
  }, [project.walls, selectedWallIds]);
  const selectionCount = selectedWalls.length;
  // Erste gewählte Wand (für Status-Leiste / Kontextmenü-Aktionen mit Einzelbezug).
  const selectedWall = selectedWalls[0] ?? null;

  // Aktive Ebene (Kategorie) der Status-Leiste: die Kategorie der (ersten)
  // gewählten Wand, sonst „—" (es gibt keine eigenständige Kategorie-Selektion).
  const activeLayerName =
    selectionCount === 1 && selectedWall
      ? categoryLabel(project.layers, selectedWall.categoryCode)
      : categoryLabel(project.layers, activeCategoryCode);
  // Kontextueller Werkzeug-Hinweis (links). Zeigt die Anzahl gewählter Wände:
  // 0 → „Auswahl", 1 → „Auswahl: 1 Wand", n → „Auswahl: n Wände".
  const toolHint =
    selectionCount === 0
      ? t("status.selection")
      : t("status.selectionN", {
          n: selectionCount,
          noun: selectionCount === 1 ? t("status.wall") : t("status.walls"),
        });

  // Solange keine Plan-Ansicht montiert ist, gibt es keinen Live-Massstab.
  // (PlanView meldet beim Montieren/Zoomen sofort wieder einen Wert.)
  useEffect(() => {
    if (!planActive) setLiveScale(null);
  }, [planActive]);

  // Zoom-Buttons der Oberleiste an die montierte Plan-Ansicht weiterreichen.
  const fitPlan = () => planViewRef.current?.fit();
  const fitSelection = () => planViewRef.current?.fitSelection();
  // Papier-Massstab anwenden: gewählten Nenner merken UND den Plan-Zoom exakt
  // auf 1:N setzen (PlanView rechnet die viewBox aus N + Canvas + dpi).
  const applyScale = (n: number) => {
    setScaleDenominator(n);
    planViewRef.current?.applyScale(n);
  };
  // „100 %" = Zoom exakt auf den gewählten Massstab setzen.
  const zoomToApplied = () => planViewRef.current?.applyScale(scaleDenominator);

  // Massstäbliche Inhalts-Maße (Meter) des aktuellen Plans — nur berechnet, wenn
  // der Export-Dialog offen ist (für die „passt aufs Blatt?"-Warnung).
  const exportContentMeters = useMemo(() => {
    if (!exportOpen) return undefined;
    const b = generatePlan(
      project,
      activeLevel.id,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
    ).bounds;
    return { w: b.maxX - b.minX, h: b.maxY - b.minY };
  }, [
    exportOpen,
    project,
    activeLevel.id,
    visibleCodes,
    categoryDisplay,
    detail,
    referenceLines,
    planColorMode,
  ]);

  // PDF-Export: erzeugt den Plan mit EXAKT denselben Eingaben wie die Ansicht
  // (Geschoss, sichtbare Codes, Darstellungsmodus, Detailgrad, Referenzlinien,
  // Farb-/Mono-Modus) und schreibt ihn massstäblich als Vektor-PDF. Reines
  // Modell → SVG → PDF, unabhängig vom Bildschirm-DOM.
  // PDF-/DXF-Plan-Export — siehe state/useExportHandlers.ts.
  const { onExportPdf, onExportSvg, onExportDxf } = useExportHandlers({
    project,
    activeLevelId: activeLevel.id,
    activeLevelName: activeLevel.name,
    visibleCodes,
    categoryDisplay,
    detail,
    referenceLines,
    planColorMode,
    selectionMembers: selectionLockMembers,
    setExportOpen,
    setExportDxfOpen,
  });

  // Option der Befehlszeile (Klick, Kürzel): „N Kopien"/„Verteilen" fragen erst die Anzahl ab
  // (Dialog), dann geht die Option mit der Zahl an den laufenden Befehl.
  const onCommandOption = (id: string) => {
    if (id === "array" || id === "distribute") requestCopyCount(id);
    else engine.chooseOption(id);
  };

  // Feld-Zustand fürs Cursor-HUD (neben der Maus, VW-Stil): läuft ein Punkt-
  // ODER Kanten-Griff-Drag, hat er Vorrang (dieselben Felder wie unten in der
  // Befehlszeile — Länge/Winkel- bzw. Abstand-Tab-Zyklus), sonst die Befehls-
  // Engine-Felder (Zeichnen; Winkel beim Drehen bzw. Distanz beim Bewegen). Vorher zeigte das Cursor-HUD beim Griff-Ziehen
  // GAR KEINE Länge/Winkel-Werte an (nur die Befehlszeile unten) — Nutzer-
  // Wunsch: „du kannst [Länge/Winkel] gleich bei der Maus anzeigen wie beim
  // Erstellen".
  const hudFields =
    gripEdit
      ? { fields: gripEditFields(), typed: cmdTyped }
      : edgeEdit
        ? { fields: edgeEditFields(), typed: cmdTyped }
        : grip3dEdit
          ? {
              fields: grip3dEditFields(grip3dEdit, last3dDragRef.current?.raw ?? grip3dEdit.anchor),
              typed: cmdTyped,
            }
          : commandActive && engineView.fields.length > 0
            ? {
                fields: engineView.fields.map((f) => ({
                  id: f.id,
                  value: f.value,
                  locked: f.locked,
                  active: f.active,
                })),
                typed: cmdTyped,
              }
            : null;


  // Maus-Schema: Auswahl + Kontextmenü aus Grundriss / 3D — siehe
  // state/useMouseSelectionHandlers.ts.
  const {
    onOpenStampEditor,
    onEditDrawingText,
    commitTextEdit,
    closeTextEdit,
    onPlanSelect,
    onPlanMarquee,
    onPlanContextMenu,
    onViewport3dPick,
  } = useMouseSelectionHandlers({
    project,
    setProject,
    activeLevelId: activeLevel.id,
    visibleCodes,
    categoryDisplay,
    floorDisplay,
    selectionState: {
      selectedWallIds,
      setSelectedWallIds,
      selectedDrawingIds,
      setSelectedDrawingIds,
      setSelectedDrawingId,
      selectedCeilingIds,
      setSelectedCeilingIds,
      selectedOpeningIds,
      setSelectedOpeningIds,
      selectedStairIds,
      setSelectedStairIds,
      selectedRoomIds,
      setSelectedRoomIds,
      selectedExtrudedSolidIds,
      setSelectedExtrudedSolidIds,
      selectedColumnIds,
      setSelectedColumnIds,
      selectedRoofIds,
      setSelectedRoofIds,
      selectedContextObjectIds,
      setSelectedContextObjectIds,
      selectedSectionLineIds,
      setSelectedSectionLineIds,
      selectedGroupIds,
      setSelectedGroupIds,
      groupPath,
    },
    contextMenuState: { setMenu, setStampEditorRoomId, editTextId, setEditTextId, setEditTextMinHeightM },
  });

  // „Bild einfügen" (Werkzeug „image") — siehe state/useImportHandling.ts.
  const { onImageOrPdfFileChosen } = useImageImportHandling({
    activeLevelId: activeLevel.id,
    activeCategoryCode,
    // Auf einem Blatt: 60 mm breit, mitten aufs Papier.
    imagePlacement: sheetPane
      ? (() => {
          const m = findMaster(project, sheetPane.layout);
          const size = effectiveSheetSizeMm(m ?? sheetPane.layout);
          return { widthM: 0.06, center: sheetMmToModel(size.w / 2, size.h / 2) };
        })()
      : undefined,
    applyChange,
    notify,
    setSelectedDrawingId,
    setSelectedWallIds,
    setSelectedCeilingIds,
    setSelectedOpeningIds,
    setSelectedStairIds,
    setSelectedRoomIds,
    setSelectedExtrudedSolidIds,
    setSelectedColumnIds,
    setSelectedRoofIds,
    setSelectedContextObjectIds,
    setSelectedSectionLineIds,
  });

  // App-weites Drag & Drop einer DXF/DWG-Datei — siehe state/useImportHandling.ts.
  const { onAppDragEnter, onAppDragOver, onAppDragLeave, onAppDrop } = useFileDropImport(
    setDropActive,
    openImportForAnyFile,
    (files) => {
      // Mehrere Dateien: Modell + Begleitdateien (.mtl/.bin) gemeinsam an den Mesh-Import.
      const r = splitMeshFiles(files);
      if (!r) return false;
      requestMeshImport(r.file, r.sidecars);
      return true;
    },
  );

  // Host-Context für die Panels — siehe state/usePanelHostBase.ts.
  const baseHost = usePanelHostBase({
    project,
    setProject,
    applyChange,
    activeLevelId,
    setActiveLevelId,
    activeLevel,
    viewType,
    setViewType,
    engineView,
    onSelectTool,
    onRunCommand,
    sectionLine,
    onToggleSection3dCut,
    openLayerSettings,
    openSettings,
    onOpenStampEditor,
    openResources,
    dxfInputRef,
    planViewRef,
    selection,
    projectActions: {
      toggleLevelVisible,
      toggleCategoryVisible,
      addFloor,
      addDrawing,
      addSection,
      addElevation,
      addCategory,
      snapshotLayerVisibility,
      applyLayerVisibility,
      snapshotDrawingVisibility,
      applyDrawingVisibility,
      patchLevel,
      patchComponent,
      addComponent,
      deleteComponent,
      patchHatch,
      addHatch,
      deleteHatch,
      patchLineStyle,
      addLineStyle,
      deleteLineStyle,
      patchTextStyle,
      addTextStyle,
      deleteTextStyle,
      patchWallType,
      addWallType,
      deleteWallType,
      patchCeilingType,
      addCeilingType,
      deleteCeilingType,
      patchRoofType,
      addRoofType,
      deleteRoofType,
      importLineStyles,
      importHatches,
      addContextObjectsAndFit,
      removeContextObject,
      removeContextObjects,
      generateTerrain,
      patchContextObject,
      commitTransformOn,
      setElementColor,
      setElementWeight,
      setElementFill,
      setElementFillColor,
      setElementForeground,
      setElementBackground,
      updateDrawing2D,
      resizeElement,
      updateWall,
      setWallThickness,
      updateOpening,
      updateCeiling,
      setCeilingThickness,
      updateStair,
      updateRoom,
      addColorToCustomPalette,
    },
    selectionState: {
      updateRoof,
      setSelectedWallIds,
      setSelectedDrawingId,
      selectedContextObjectIds,
      setSelectedCeilingIds,
      setSelectedOpeningIds,
      setSelectedStairIds,
      setSelectedRoomIds,
      setSelectedExtrudedSolidIds,
      setSelectedColumnIds,
      setSelectedRoofIds,
      setSelectedContextObjectIds,
      selectedSectionLineId,
      setSelectedSectionLineIds,
      section3dCutId,
    },
    toolState: {
      activeTool,
      activeWallTypeId,
      setActiveWallTypeId,
      activeCategoryCode,
      setActiveCategoryCode,
      snap,
      setSnap,
    },
    topBarState: {
      detail,
      setDetail,
      view3d,
      setView3d,
      fov,
      setFov,
      scaleDenominator,
      setScaleDenominator,
      selectedViewSnapshotId,
      setSelectedViewSnapshotId,
    },
    dialogState: { setActiveLayoutId, setOpeningEditorId },
    contextMenuState: { setMenu },
  });

  // ── Stabile Handler + memoisierte Kinder ([121]) ─────────────────────────
  // Handler für memoisierte Kinder als EIN Bündel mit stabiler Identität (`useEventBundle`): ein
  // App-Render (z. B. nach einer Op) ändert deren Props dann nicht, sie rendern nicht mit.
  const ev = useEventBundle({
    onNewProject,
    onNewProjectFromSample,
    onNewProjectFromComplexSample,
    onNewProjectFromTemplate,
    onOpenProject,
    onSaveProject,
    onImport: () => dxfInputRef.current?.click(),
    onImportPointCloud: () => openPointCloudFileDialog(),
    onImportMesh: () => openMeshFileDialog(),
    onOpenExportDxf: () => setExportDxfOpen(true),
    onExportIfc,
    onExportObj,
    onExportStl,
    onDeleteSelection: deleteSelection,
    onToggleResources: () => toggleResources(),
    onOpenSettings: () => openSettings(),
    onOpenBcf: () => setLayout((l) => revealPanel(l, "bcf")),
    onOpenHistory: () => setLayout((l) => revealPanel(l, "history")),
    applyScale,
    fitPlan,
    fitSelection,
    zoomToApplied,
    onShadows: (v: boolean) => applyChange((p) => patchItem(p, "drawingLevels", activeLevel.id, { shadows: v })),
    // Ebenen-Kombinationen: Speichern = Snapshot des Layer-Baums → localStorage; Laden = Map
    // lesen → Sichtbarkeits-Flags anwenden. Zeichnungs-Kombinationen analog über drawingLevels[].visible.
    saveLayerCombo: (name: string) => saveLayerCombo(name, snapshotLayerVisibility()),
    loadLayerCombo: (name: string) => {
      const codes = loadLayerCombo(name);
      if (codes) applyLayerVisibility(codes);
    },
    saveDrawingCombo: (name: string) => saveDrawingCombo(name, snapshotDrawingVisibility()),
    loadDrawingCombo: (name: string) => {
      const ids = loadDrawingCombo(name);
      if (ids) applyDrawingVisibility(ids);
    },
    onCommandOption,
    onCmdSubmit: (text: string) => {
      // Feld-Controller (Griff, Kante): getippte Länge in Anzeige-Einheiten
      // (Blatt: Papier-mm) → Meter; Winkel/Anzahl bleiben.
      const ctlFields = gripEdit
        ? gripEditFields()
        : edgeEdit
        ? edgeEditFields()
        : [];
      const ctlActive = ctlFields.find((f) => f.active)?.id;
      const typed = (raw: string): number => {
        const n = parseFloat(raw.replace(",", "."));
        return ctlActive && !NON_LENGTH_FIELDS.has(ctlActive) ? lengthFromDisplay(displayUnits, n) : n;
      };
      if (gripEdit) {
        const v = typed(text);
        if (isFinite(v)) submitGripEditValue(v);
        // Leere Eingabe: kein neuer Wert zu locken — Enter bestätigt
        // stattdessen die aktuelle Position (Maus- oder bereits
        // gelockte Werte) und schließt die Griff-Bearbeitung ab. Vorher
        // ein Totdruck (Nutzer-Report: Enter tat nichts).
        else planViewRef.current?.confirmGripEdit();
        return;
      }
      if (edgeEdit) {
        const v = typed(text);
        if (isFinite(v)) submitEdgeEditValue(v);
        else planViewRef.current?.confirmEdgeEdit();
        return;
      }
      if (grip3dEdit) {
        const v = parseFloat(text.replace(",", "."));
        if (isFinite(v)) submitGrip3dEditValue(v);
        // Leere Eingabe: Feld-Controller schliessen, Maus steuert den
        // laufenden Griff-Drag wieder normal weiter (kein 3D-Äquivalent
        // zu `confirmGripEdit` — die Maustaste bleibt physisch gedrückt).
        else setGrip3dEdit(null);
        return;
      }
      engine.submitText(text);
    },
    onCmdCycleField: () =>
      gripEdit
        ? cycleGripEditField()
        : edgeEdit
        ? cycleEdgeEditField()
        : grip3dEdit
        ? cycleGrip3dEditField()
        : engine.cycleField(),
    onCmdCancel: () =>
      gripEdit
        ? closeGripEditField()
        : edgeEdit
        ? closeEdgeEditField()
        : grip3dEdit
        ? setGrip3dEdit(null)
        : engine.escape(),
    cmdStillActive: () => engine.isActive(),
    cmdSuggest: (prefix: string) => engine.suggest(prefix),
    // Hauptansicht (Grundriss/3D).
    onToggleGrid3d: () => setGrid3dVisible(!grid3dVisible),
    onClearSection3d: () => setSection3dCutId(null),
    moveRoomStamp,
    onOpenStampEditor,
    onEditDrawingText,
    onEnterGroup,
    onLeaveGroup,
    commitTextEdit,
    closeTextEdit,
    onPlanSelect,
    onPlanMarquee,
    onSegmentCut,
    onPlanContextMenu,
    onViewport3dPick,
    onWorkplanePoint,
    onWorkplaneConfirm,
    onToolMove: toolHandlers.onToolMove,
    onToolClick: toolHandlers.onToolClick,
    onToolCommit: toolHandlers.onToolCommit,
    onMeshImport: (read: MeshRead, fileName: string, placement: MeshPlacement) => {
      // Der Kern macht die Kontext-Meshes und übernimmt sie als EINEN Undo-Schritt ([K4] S4).
      const r = getState().commitImport((doc, base, now) => doc.importMesh(base, read.flat, { fileName, placement }, now), "history.import.mesh");
      if (!r) return;
      fitToContextObjects(addedItems(r.ops, "context") as ContextObject[]);
      notify(formatMeshReport(read.report, t), r.contextObjects === 0 || read.report.truncated ? "warning" : "info");
    },
  });
  // Befehlszeile (Rhino-artig): Während eines Vertex- ODER Kanten-Griff-Drags belegt der Feld-
  // Controller das Befehlsfeld (Länge/Winkel bzw. Abstand). Läuft eine Auswahl-Transformation
  // (Drehen etc.), belegt sie Prompt + U/I/O/P + Winkel-/Distanzfeld. Sonst gilt die Engine
  // (Zeichnen/Ruhe). Griff-/Kanten-Drag haben Vorrang (schließen sich sonst aus).
  const fieldController = !!(gripEdit || edgeEdit || grip3dEdit);
  const cmdLineActive = fieldController ? true : engineView.active;
  const cmdLinePromptKey = gripEdit
    ? "cmd.edit.point"
    : edgeEdit
    ? "cmd.edit.edge"
    : grip3dEdit
    ? "cmd.edit.point"
    : engineView.promptKey;
  const cmdLineOptions = fieldController ? NO_OPTIONS : engineView.options;
  const cmdLineFields = gripEdit
    ? gripEditFields()
    : edgeEdit
    ? edgeEditFields()
    : grip3dEdit
    ? grip3dEditFields(grip3dEdit, last3dDragRef.current?.raw ?? grip3dEdit.anchor)
    : engineView.fields;
  const cmdLineSteps = fieldController ? 0 : engineView.steps;
  const contentToolHandlers: ToolHandlers = useMemo(
    () => ({ onToolMove: ev.onToolMove, onToolClick: ev.onToolClick, onToolCommit: ev.onToolCommit, draft }),
    [ev, draft],
  );
  const viewSnapshotTabs = useMemo(
    () => ({
      selectedId: baseHost.selectedViewSnapshotId,
      onApply: baseHost.onApplyViewSnapshot,
      onCaptureAuto: baseHost.onCaptureViewSnapshotAuto,
      autoName: baseHost.viewSnapshotAutoName,
      onDelete: baseHost.onDeleteViewSnapshot,
    }),
    [baseHost],
  );
  const hasSelection = hasSelectionToDelete();
  // Unter Tauri (macOS) übernimmt die native Systemmenüleiste (oben am Bildschirm,
  // useNativeAppMenu) exakt dieselben Aktionen bereits — die In-App-Menüleiste wäre reine
  // Dopplung und kostet nur Platz in der Kopfzeile. Im Browser/Electron (kein natives
  // App-Menü) bleibt sie die einzige Quelle dafür.
  const menuBarEl = useMemo(
    () =>
      isTauriRuntime() ? undefined : (
        <AppMenuBar
          onNewProject={ev.onNewProject}
          onNewProjectFromSample={ev.onNewProjectFromSample}
          onNewProjectFromComplexSample={ev.onNewProjectFromComplexSample}
          onNewProjectFromTemplate={ev.onNewProjectFromTemplate}
          onOpenProject={ev.onOpenProject}
          onSaveProject={ev.onSaveProject}
          onImport={ev.onImport}
          onImportPointCloud={ev.onImportPointCloud}
          onImportMesh={ev.onImportMesh}
          onExportDxf={ev.onOpenExportDxf}
          onExportIfc={ev.onExportIfc}
          onExportObj={ev.onExportObj}
          onExportStl={ev.onExportStl}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          onDeleteSelection={ev.onDeleteSelection}
          hasSelection={hasSelection}
          viewType={viewType}
          onViewType={setViewType}
          view3d={view3d}
          onView3d={setView3d}
          referenceLines={referenceLines}
          onReferenceLines={setReferenceLines}
          resourcesOpen={resourcesOpen}
          onToggleResources={ev.onToggleResources}
          onOpenSettings={ev.onOpenSettings}
          onOpenBcf={ev.onOpenBcf}
          onOpenHistory={ev.onOpenHistory}
        />
      ),
    [ev, undo, redo, canUndo, canRedo, hasSelection, viewType, setViewType, view3d, setView3d, referenceLines, setReferenceLines, resourcesOpen],
  );
  const combos = useMemo(
    () => ({
      listLayerCombos,
      saveLayerCombo: ev.saveLayerCombo,
      loadLayerCombo: ev.loadLayerCombo,
      deleteLayerCombo,
      listDrawingCombos,
      saveDrawingCombo: ev.saveDrawingCombo,
      loadDrawingCombo: ev.loadDrawingCombo,
      deleteDrawingCombo,
    }),
    [ev],
  );
  const textStyles = project.textStyles ?? DEFAULT_PRESETS;
  const shadowsAvailable = activeLevel.kind === "elevation";
  const shadows = activeLevel.shadows ?? false;
  const viewControlsEl = useMemo(
    () => (
      <ViewRibbonTab
        viewToggleEnabled={has3dView}
        viewType={viewType}
        onViewType={setViewType}
        view3d={view3d}
        onView3d={setView3d}
        detail={detail}
        onDetail={setDetail}
        // Detailgrad wirkt im Grundriss UND in der 3D-Sicht
        // (projectToModel3d bekommt `detail` durchgereicht).
        detailEnabled={planActive || viewType === "perspektive"}
        scaleDenominator={scaleDenominator}
        onApplyScale={ev.applyScale}
        zoomEnabled={planActive}
        onFit={ev.fitPlan}
        onFitSelection={ev.fitSelection}
        onZoom100={ev.zoomToApplied}
        renderMode={renderMode}
        onRenderMode={setRenderMode}
        renderModeEnabled={viewType === "perspektive"}
        planColorMode={planColorMode}
        onPlanColorMode={setPlanColorMode}
        shadowsAvailable={shadowsAvailable}
        shadows={shadows}
        onShadows={ev.onShadows}
        combos={combos}
        textTarget={textTarget}
        textStyles={textStyles}
      />
    ),
    [
      ev,
      combos,
      has3dView,
      viewType,
      setViewType,
      view3d,
      setView3d,
      detail,
      setDetail,
      planActive,
      scaleDenominator,
      renderMode,
      setRenderMode,
      planColorMode,
      setPlanColorMode,
      shadowsAvailable,
      shadows,
      textTarget,
      textStyles,
    ],
  );

  if (bootPhase === "splash") {
    return <SplashScreen onDone={() => setBootPhase("start")} />;
  }
  if (bootPhase === "start") {
    return (
      <>
      <StartScreen
        onNewProject={() => {
          onNewProject();
          setBootPhase("editor");
        }}
        onOpenProject={() => {
          onOpenProject();
          setBootPhase("editor");
        }}
        onOpenRecent={(path) => {
          void openProjectAtPath(path).then((found) => {
            if (!found) notify(t("start.recentMissing"), "error");
          });
          setBootPhase("editor");
        }}
      />
      {recovery && (
        <RecoverAutosaveDialog
          path={recovery.path}
          savedAt={recovery.savedAt}
          onRestore={() => {
            onRecoverRestore();
            setBootPhase("editor");
          }}
          onDiscard={onRecoverDiscard}
          onLater={onRecoverLater}
        />
      )}
      </>
    );
  }

  return (
    <div
      className="app"
      onDragEnter={onAppDragEnter}
      onDragOver={onAppDragOver}
      onDragLeave={onAppDragLeave}
      onDrop={onAppDrop}
    >
      {/* Verstecktes DXF-Datei-Input (Site-Panel/„import"-Befehl triggern es). */}
      <input
        ref={dxfInputRef}
        type="file"
        accept=".dxf,.dwg,.ifc,.pdf,text/plain"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openImportForAnyFile(f);
          e.target.value = "";
        }}
      />
      {/* Verstecktes STEP-Datei-Input (Menü Datei, STEP importieren). */}
      <input
        ref={stepInputRef}
        type="file"
        accept=".stp,.step,.p21"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          void f
            .text()
            .then((text) => readStepFlat(text))
            .then((flat) => {
              // Der Kern macht je Körper ein Kontext-Mesh und übernimmt sie als EINEN Undo-Schritt ([K4] S4).
              const r = getState().commitImport((doc, base, now) => doc.importStep(base, flat, { fileName: f.name }, now));
              if (r) fitToContextObjects(addedItems(r.ops, "context") as ContextObject[]);
            })
            .catch((err) =>
              notify(`${t("step.import.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error"),
            );
        }}
      />
      {/* Punktwolken-Import ([27]): verstecktes Datei-Feld + Dialog (UI-Store, nicht im Projekt). */}
      <PointCloudImportHost />
      {/* 3D-Modell-Import (OBJ/STL/glTF/GLB/PLY): verstecktes Datei-Feld + Dialog. */}
      <MeshImportHost notify={notify} onImport={ev.onMeshImport} />
      {/* Verstecktes IFC-Datei-Input (Menü Datei, IFC importieren). */}
      <input
        ref={ifcInputRef}
        type="file"
        accept=".ifc"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) importIfcFile(f);
        }}
      />
      {/* Verstecktes Bild/PDF-Datei-Input (Werkzeug „image"). */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*,.pdf,application/pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImageOrPdfFileChosen(f);
          e.target.value = "";
        }}
      />
      {/* Verstecktes Projekt-Datei-Input (Datei-Burger „Öffnen"). */}
      <input
        ref={projectFileInputRef}
        type="file"
        accept="application/json,.json,.obp"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onProjectFileChosen(f);
          e.target.value = "";
        }}
      />
      {/* Verstecktes Vorlagen-Datei-Input („Neu aus Vorlage" → Datei wählen). */}
      <input
        ref={projectTemplateFileInputRef}
        type="file"
        accept={`.${PROJECT_TEMPLATE_EXT}`}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onProjectTemplateFileChosen(f);
          e.target.value = "";
        }}
      />
      {/* Schmale globale Leiste: Marke/Menü · Datei/Export/Einstellungen.
          Ansichts-/Zoom-/Darstellungs-Steuerung folgt direkt darunter
          (ViewRibbonTab, permanent — kein Tab-Umschalter mehr). */}
      <TopBar projectName={project.name} menuBar={menuBarEl} viewControls={viewControlsEl} />

      <div className="body">
        {/* Linkes Dock: gestapelte Gruppen (Werkzeuge oben, Zeichnungsebenen/
            Ebenen unten). Jede Gruppe baut über buildHost ihren eigenen
            Host-Provider, damit der Darstellungsmodus dem aktiven Tab DIESER
            Gruppe folgt. Nur gerendert, wenn das Dock Gruppen hat. */}
        {leftHasTabs && (
          <Dock
            side="left"
            dock={layout.left}
            onStartTabDrag={startTabDrag}
            onResize={(size) => resizeDock("left", size)}
            onResizeGroups={(w) => resizeGroups("left", w)}
            buildHost={(activeTab) =>
              hostWithMode(baseHost, activeTab, modeFor, setModeFor, draft?.measure ?? null)
            }
            displayModeFor={(activeTab) => modeFor(activeTab)}
            onDisplayModeChange={(activeTab, m) => setModeFor(activeTab, m)}
          />
        )}

        {/* Mitte-Spalte: Hauptansicht + Befehlszeile DARUNTER. So ist die
            Befehlszeile nur so breit wie der Viewport (nicht die ganze App),
            und die Docks nehmen die volle Body-Höhe ein (inkl. der Zeile). */}
        <div className="center-col">
        {(
        <>
        {/* Hauptansicht (Mitte) — füllt den verbleibenden Platz. Die Plan-
            Ansicht meldet Cursor + Zoom an die Status-/Oberleiste und nimmt
            das Zoom-Handle entgegen. */}
        <Content
          sheet={sheetPane}
          project={project}
          level={activeLevel}
          viewType={viewType}
          visibleCodes={visibleCodes}
          detail={detail}
          referenceLines={referenceLines}
          scaleDenominator={scaleDenominator}
          hairline={lineMode === "display"}
          showGrid={snap.showGrid}
          marqueeColor={marqueeColor}
          snapColor={snapColor}
          hoverDivideDelayMs={snap.hoverDivideDelayMs}
          hoverDivideCount={snap.hoverDivideCount}
          renderMode={renderMode}
          view3d={view3d}
          fov={fov}
          grid3dVisible={grid3dVisible}
          onToggleGrid3d={ev.onToggleGrid3d}
          section3d={section3dPlane}
          onClearSection3d={ev.onClearSection3d}
          mono={planColorMode === "mono"}
          viewSnapshotTabs={viewSnapshotTabs}
          onSelectLevel={setActiveLevelId}
          floorDisplay={floorDisplay}
          categoryDisplay={categoryDisplay}
          displayKey={displayKey}
          planViewRef={planViewRef}
          onCursor={setCursor}
          onScale={setLiveScale}
          selectedWallIds={selectedWallIds}
          selectedCeilingIds={selectedCeilingIds}
          selectedOpeningIds={selectedOpeningIds}
          selectedStairIds={selectedStairIds}
          selectedExtrudedSolidIds={selectedExtrudedSolidIds}
          selectedColumnIds={selectedColumnIds}
          selectedGroupIds={selectedGroupIds}
          selectedRoomIds={selectedRoomIds}
          selectedRoofIds={selectedRoofIds}
          selectedContextObjectIds={selectedContextObjectIds}
          selectedSectionLineIds={selectedSectionLineIds}
          roomStamp={roomStamp}
          onStampMove={ev.moveRoomStamp}
          onStampEdit={ev.onOpenStampEditor}
          onEditDrawingText={ev.onEditDrawingText}
          onEnterGroup={ev.onEnterGroup}
          onLeaveGroup={ev.onLeaveGroup}
          groupPath={groupPath}
          editTextId={editTextId}
          editTextMinHeightM={editTextMinHeightM}
          onCommitTextEdit={ev.commitTextEdit}
          onCloseTextEdit={ev.closeTextEdit}
          onPlanSelect={ev.onPlanSelect}
          onPlanMarquee={ev.onPlanMarquee}
          onSegmentCut={ev.onSegmentCut}
          onPlanContextMenu={ev.onPlanContextMenu}
          onViewport3dPick={ev.onViewport3dPick}
          // Zeichnen-Modus des 3D-Viewports (auch Bewegen/Drehen/Spiegeln sind Befehle).
          commandActive={commandActive}
          draft={draft}
          onWorkplanePoint={ev.onWorkplanePoint}
          onWorkplaneConfirm={ev.onWorkplaneConfirm}
          activeTool={activeTool}
          toolInputActive={toolInputActive}
          toolHandlers={contentToolHandlers}
          hudFields={hudFields}
          grips={grips}
          gripHandleLines={gripHandleLines}
          edgeGrips={edgeGrips}
          selectedDrawingId={selectedDrawingId}
          selectedDrawingIds={selectedDrawingIds}
          gripHandlers={gripHandlers}
          edit3dWalls={edit3dWalls}
          edit3dDrawings={edit3dDrawings}
          edit3dCeilings={edit3dCeilings}
          edit3dRoofs={edit3dRoofs}
          onEdit3dVertex={onEdit3dVertex}
          onEdit3dBody={onEdit3dBody}
          onEdit3dEdge={onEdit3dEdge}
          onEdit3dRoofPitch={onEdit3dRoofPitch}
          onEdit3dWallTop={onEdit3dWallTop}
          onEdit3dEnd={onEdit3dEnd}
          onEdit3dGroup={groupChanges}
          onGrip3dEditTab={cycleGrip3dEditField}
          onGrip3dEditCancel={cancelGrip3dEdit}
        />
        {/* Command-Line (Rhino-artig) UNTER dem Viewport — nur Viewport-breit.
            Prompt + klickbare Inline-Optionen + Texteingabe + Autocomplete. */}
        <CommandLine
          ref={commandLineRef}
          units={displayUnits}
          active={cmdLineActive}
          promptKey={cmdLinePromptKey}
          options={cmdLineOptions}
          fields={cmdLineFields}
          onSubmit={ev.onCmdSubmit}
          onOption={ev.onCommandOption}
          onCycleField={ev.onCmdCycleField}
          onCancel={ev.onCmdCancel}
          stillActive={ev.cmdStillActive}
          steps={cmdLineSteps}
          suggest={ev.cmdSuggest}
          onTextChange={setCmdTyped}
        />
        </>
        )}
        </div>

        {/* Rechtes Dock: standardmäßig leer (Ressourcen ist ein schwebendes
            Fenster). Nur gerendert, wenn es Gruppen hat — sonst nutzt die Mitte
            den freigewordenen Platz. */}
        {rightHasTabs && (
          <Dock
            side="right"
            dock={layout.right}
            onStartTabDrag={startTabDrag}
            onResize={(size) => resizeDock("right", size)}
            onResizeGroups={(w) => resizeGroups("right", w)}
            buildHost={(activeTab) =>
              hostWithMode(baseHost, activeTab, modeFor, setModeFor, draft?.measure ?? null)
            }
            displayModeFor={(activeTab) => modeFor(activeTab)}
            onDisplayModeChange={(activeTab, m) => setModeFor(activeTab, m)}
          />
        )}

        {/* Rand-Andock-Zonen (links/rechts) — nur während einer Drag-Geste
            (Tab-Ziehen ODER Titel-Drag eines Fensters). Sie sind die
            Trefferflächen für „hierher andocken"; data-drop-zone wird von der
            Drag-Auflösung (panelDrag/onFloatTitleDrop) gelesen. */}
        {dragActive && (
          <>
            <div
              className={`drop-zone drop-zone-left${
                activeZone === "left" ? " active" : ""
              }`}
              data-drop-zone="left"
            />
            <div
              className={`drop-zone drop-zone-right${
                activeZone === "right" ? " active" : ""
              }`}
              data-drop-zone="right"
            />
          </>
        )}

        {/* Schwebende Panels ÜBER der Mitte. Jedes bekommt einen eigenen
            Host-Provider, damit sein Darstellungsmodus-Umschalter dem eigenen
            Panel folgt (wie bei den Docks). Verschieben/Größe/Andocken/Schließen
            schreiben das Layout fort (persistiert via useEffect). */}
        {layout.floating.map((fp) => (
          <PanelHostProvider
            key={fp.panelId}
            value={hostWithMode(baseHost, fp.panelId, modeFor, setModeFor, draft?.measure ?? null)}
          >
            <FloatingPanel
              panel={fp}
              displayMode={modeFor(fp.panelId)}
              onDisplayModeChange={(m) => setModeFor(fp.panelId, m)}
              onFocus={focusFloat}
              onMove={moveFloat}
              onResize={resizeFloat}
              onRedock={redockFloat}
              onClose={closeFloat}
              onTitleDrag={onFloatTitleDrag}
              onTitleDrop={onFloatTitleDrop}
            />
          </PanelHostProvider>
        ))}
      </div>

      {/* Drag-Overlay (Geist + Tab-Einfüge-Caret) während eines Tab-Ziehens. */}
      <DragOverlay drag={drag} />

      {/* Footer / Status-Leiste (unten). Werte rein aus Modell + View-State.
          Cursor/Zoom nur, wenn eine Plan-Ansicht aktiv ist (sonst „—"). */}
      <StatusBar
        hint={toolHint}
        showCursor={planActive}
        unit="m"
        units={displayUnits}
        referenceLines={referenceLines}
        onReferenceLines={setReferenceLines}
        referenceLinesEnabled={planActive}
        activeFloor={activeLevel.name}
        activeLayer={activeLayerName}
        lineMode={lineMode}
        onLineModeChange={setLineMode}
        // Display/Print wirkt in ALLEN 2D-Darstellungen (Grundriss, Schnitt,
        // Ansicht, Zeichnung — hairline fliesst überall hin); nur die
        // 3D-Perspektive kennt keine Papier-Linienstärken.
        lineModeEnabled={!has3dView || viewType === "grundriss"}
        snap={snap}
        onSnapChange={setSnap}
      />

      {/* Frei schwebendes, NICHT-modales Ressourcen-Fenster: kein Backdrop, der
          Grundriss dahinter bleibt bedienbar (Schraffur-/Linien-Änderungen live
          am Modell sichtbar). Verschiebbar über die Kopfzeile, größenveränderbar
          über den Greifer unten rechts. Der „Ressourcen"-Knopf toggelt; Esc
          schließt (siehe Effekt oben). */}
      {resourcesOpen && (
        <ResourceManager
          project={project}
          handlers={resourceHandlers}
          initialTab={resourcesTab}
          onClose={() => setResourcesOpen(false)}
        />
      )}

      {/* Reicher Fenster-/Tür-Einstellungsdialog (⚙ der OpeningSection). */}
      {openingEditorId != null && (
        <OpeningEditorDialog
          openingId={openingEditorId}
          project={project}
          onPatchWindowType={patchWindowType}
          onPatchDoorType={patchDoorType}
          onPatchOpening={(patch) => updateOpening(openingEditorId, patch)}
          onSetOpeningType={(typeId) => updateOpening(openingEditorId, { typeId: typeId || undefined })}
          onSaveAsStyle={(name) => saveOpeningStyle(openingEditorId, name)}
          onClose={() => setOpeningEditorId(null)}
        />
      )}

      <BusyOverlay />
      <AiActivityPanel />

      {/* Modaler Import-Dialog (DXF/DWG) — offen, sobald eine Datei gewählt/
          fallengelassen wurde. Liefert eine strukturierte Entscheidung an
          runImport (Ebene anlegen / Drawings anhängen / Meshes als Kontext). */}
      {importState && (
        <ImportDialog
          fileName={importState.fileName}
          isDwg={importState.isDwg}
          loading={importState.loading ?? false}
          progress={importState.progress}
          error={importState.error}
          onSelectLayout={loadImportLayout}
          parsed={importState.parsed}
          pdf={importState.pdf}
          onPdfChange={setImportPdfOptions}
          project={project}
          activeCategoryCode={activeCategoryCode}
          onImport={runImport}
          onClose={() => setImportState(null)}
        />
      )}

      {/* PDF-/SVG-Export-Dialog (Grundriss → Vektor-PDF oder -SVG). Nur im
          Grundriss eines Geschosses sinnvoll; der Button ist sonst deaktiviert. */}
      {exportOpen && (
        <ExportPdfDialog
          initialScale={scaleDenominator}
          planTitle={activeLevel.name}
          contentMeters={exportContentMeters}
          selectionCount={selectionLockIds.length}
          onExport={onExportPdf}
          onExportSvg={onExportSvg}
          onClose={() => setExportOpen(false)}
        />
      )}

      {/* DXF-Export-Dialog (Grundriss → Modell-Space-DXF in Metern). */}
      {exportDxfOpen && (
        <ExportDxfDialog
          planTitle={activeLevel.name}
          initialScale={scaleDenominator}
          selectionCount={selectionLockIds.length}
          onExport={onExportDxf}
          onClose={() => setExportDxfOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          themeMode={themeMode}
          onThemeModeChange={setThemeMode}
          marqueeColor={marqueeColor}
          onMarqueeColorChange={setMarqueeColor}
          snapColor={snapColor}
          onSnapColorChange={setSnapColor}
          referenceElevationMasl={project.referenceElevationMasl}
          onReferenceElevationChange={(n) => applyChange((p) => setFieldIfChanged(p, "referenceElevationMasl", n))}
          scaleLineWeights={project.scaleLineWeights === true}
          onScaleLineWeightsChange={setScaleLineWeights}
          offline={offline}
          onOfflineChange={onOfflineChange}
          aiAccess={aiAccess}
          onAiAccessChange={setAiAccessEnabled}
          layout={layout}
          onApplyLayout={(l) => setLayout(reconcileLayout(l))}
          onAliasOverridesChange={setAliasOverrides}
          onShortcutOverridesChange={setShortcutOverrides}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {exportSaveFormat && (
        <ExportSaveDialog
          initialFormat={exportSaveFormat}
          baseName={projectFileName()}
          onSave={(fmt, filename, ifcOptions) => {
            runExport(fmt, filename, ifcOptions);
            setExportSaveFormat(null);
          }}
          onClose={() => setExportSaveFormat(null)}
        />
      )}

      {recovery && (
        <RecoverAutosaveDialog
          path={recovery.path}
          savedAt={recovery.savedAt}
          onRestore={onRecoverRestore}
          onDiscard={onRecoverDiscard}
          onLater={onRecoverLater}
        />
      )}
      {lockConflict && (
        <LockConflictDialog
          info={lockConflict.info}
          onCancel={() => setLockConflict(null)}
          onReadOnly={() => {
            applyOpenedProjectFile(lockConflict.path, lockConflict.content, false);
            setLockConflict(null);
          }}
          onForceOpen={() => {
            // Kein eigener Lock (die andere Instanz hält ihn) — bewusste
            // Risiko-Übernahme, im Dialog als Warnung gekennzeichnet.
            applyOpenedProjectFile(lockConflict.path, lockConflict.content, false);
            setLockConflict(null);
          }}
        />
      )}

      {pendingIfc && (
        <IfcImportDialog
          fileName={pendingIfc.name}
          onCancel={() => setPendingIfc(null)}
          onImport={(mode) => {
            const f = pendingIfc;
            setPendingIfc(null);
            runIfcImport(f, mode);
          }}
        />
      )}

      {pendingDiscard && (
        <UnsavedChangesDialog
          onCancel={() => setPendingDiscard(null)}
          onDiscard={() => {
            pendingDiscard();
            setPendingDiscard(null);
          }}
          onSave={onSaveProject}
        />
      )}

      {pendingCopyMode && (
        <PromptDialog
          title={t(pendingCopyMode === "array" ? "transform.mode.array" : "transform.mode.distribute")}
          label={t("transform.countPrompt")}
          defaultValue="3"
          type="number"
          onConfirm={(v) => commitCopyCount(v, (mode, n) => engine.chooseOption(mode, n))}
          onClose={() => setPendingCopyMode(null)}
        />
      )}

      {/* Inline-Text-Editor für Drawing2D-Text (`editTextId`) rendert PlanView
          jetzt direkt auf der Zeichenfläche (kein Dialog mehr, Nutzer-Wunsch —
          gleiches Prinzip wie der Layout-Blatt-Inline-Editor). Ausgelöst über
          `text`/`textbox` (sofort nach Platzieren, s. host.focusDrawing) oder
          Doppelklick auf ein bestehendes Element (onEditDrawingText). */}

      {/* Text-Editor (schwebendes Fenster): Doppelklick auf einen Raumstempel bzw.
          Button in der Objekt-Info öffnet ihn. „Übernehmen" schreibt das
          bearbeitete Rich-Text-Dokument über setRoomStampDoc. Die Formatier-
          Leiste in der Oberleiste wirkt ebenfalls live auf den gewählten Raum. */}
      {stampEditorRoomId &&
        (() => {
          const room = (project.rooms ?? []).find((r) => r.id === stampEditorRoomId);
          if (!room) return null;
          // Strukturierter Stempel für neue Räume (kein Alt-Rich-Text) bzw. sobald
          // einer gesetzt ist; freier Text nur noch als Fallback für Alt-Räume,
          // die einen stampDoc, aber keinen strukturierten Stempel tragen.
          const useStructured = Boolean(room.stamp) || !room.stampDoc;
          if (useStructured) {
            return (
              <RoomStampEditor
                value={room.stamp ?? defaultRoomStamp(room)}
                onApply={(edited) => {
                  setRoomStamp(room.id, edited);
                  setStampEditorRoomId(null);
                }}
                onCancel={() => setStampEditorRoomId(null)}
              />
            );
          }
          const doc = room.stampDoc ?? docFromText(room.name);
          return (
            <TextEditorDialog
              value={doc}
              onApply={(edited) => {
                setRoomStampDoc(room.id, edited);
                setStampEditorRoomId(null);
              }}
              onCancel={() => setStampEditorRoomId(null)}
            />
          );
        })()}

      {/* Dezenter Drop-Rahmen, solange eine Datei über die App gezogen wird. */}
      {dropActive && (
        <div className="drop-feedback" aria-hidden="true">
          <div className="drop-feedback-inner">{t("drop.hint")}</div>
        </div>
      )}

      {/* Aktives Kontextmenü (genau eines). Die Einträge baut buildMenuItems je
          Quelle (Ebene / Zeichnungsebene / Grundriss / 3D) — alle verdrahtet
          bzw. klar deaktiviert mit Tooltip. */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menuTitle(menu, project)}
          items={buildMenuItems(menu, {
            project,
            selectedWallId,
            layerClipboard,
            openLayerEditor: (code) => openLayerSettings(code, menu.x, menu.y),
            openLevelEditor: (id) =>
              setEditor({ kind: "level", id, x: menu.x, y: menu.y }),
            addSubCategory,
            assignWallCategory,
            duplicateCategory,
            deleteCategory,
            setLayerClipboard,
            patchCategory,
            duplicateLevel,
            deleteLevel,
            clearSelection: () => setSelectedWallIds([]),
            fit: () => planViewRef.current?.fit(),
            fitSelection: () => planViewRef.current?.fitSelection(),
            closedSelectionCount: countClosedAreas(
              project.drawings2d.filter((d) =>
                selectedDrawingIds.includes(d.id),
              ),
            ),
            union: () => applyBoolean(unionDrawings),
            difference: () => applyBoolean(differenceDrawings),
            intersect: () => applyBoolean(intersectionDrawings),
            drawingSelectionCount: selectedDrawingIds.length,
            hasDrawingStyleClipboard: drawingStyleClipboard !== null,
            copyDrawingStyle,
            pasteDrawingStyle,
            lockableSelectionCount: selectionLockIds.length,
            selectionAllLocked,
            toggleSelectionLock,
            selectionLayerNames: categoryNames(project.layers, selectionLayerCodes),
            hideSelectionLayers,
            isolateSelectionLayers,
            selectionAllNoPrint: !!selectionAllNoPrint,
            toggleSelectionNoPrint,
            attachedDimensionCount: attachedDimensionIds.length,
            detachDimensions,
            bringToFront: () => reorderDrawings(selectedDrawingIds, "front"),
            bringForward: () => reorderDrawings(selectedDrawingIds, "forward"),
            sendBackward: () => reorderDrawings(selectedDrawingIds, "backward"),
            sendToBack: () => reorderDrawings(selectedDrawingIds, "back"),
            // Stützpunkt-Einträge nur bei GENAU EINER selektierten Polylinie
            // (mehrere gleichzeitig hätten keinen eindeutigen Klick-Bezug).
            selectedPolyline: (() => {
              if (selectedDrawingIds.length !== 1) return null;
              const d = project.drawings2d.find((x) => x.id === selectedDrawingIds[0]);
              return d && d.geom.shape === "polyline"
                ? { id: d.id, pts: d.geom.pts, closed: d.geom.closed, bulge: d.geom.bulge }
                : null;
            })(),
            insertPolylinePoint: insertDrawingPoint,
            deletePolylinePoint: deleteDrawingPoint,
            setPolylineVertexType,
            reorderLevel: (id, op) => reorderDrawingLevels([id], op),
          })}
          onClose={() => setMenu(null)}
        />
      )}

      {/* Inline-Editor (Ebene bzw. Geschoss) — minimaler echter Editor, der live
          auf den State wirkt. Aus einem Menüpunkt geöffnet. */}
      {editor?.kind === "layer" &&
        (() => {
          const cat = findCategory(project.layers, editor.code);
          if (!cat) return null;
          return (
            <InlineEditor
              x={editor.x}
              y={editor.y}
              title={t("editor.layerTitle", { code: cat.code })}
              onClose={() => setEditor(null)}
            >
              <EditorField label={t("editor.name")}>
                <input
                  type="text"
                  value={cat.name}
                  autoFocus
                  onChange={(e) =>
                    patchCategory(cat.code, { name: e.target.value })
                  }
                />
              </EditorField>
              <EditorField label={t("editor.color")}>
                <PenColorField
                  color={cat.colorPenId ? resolvePenColor(project, cat.colorPenId) : cat.color}
                  penId={cat.colorPenId}
                  pens={project.pens ?? []}
                  activeStyles={activePenSet(project)?.pens}
                  customPalettes={project.customPalettes}
                  builtinBanks={project.builtinPaletteBanks}
                  onSaveColor={addColorToCustomPalette}
                  showWeight
                  onColorChange={(color) => patchCategory(cat.code, { color, colorPenId: undefined })}
                  onPenChange={(colorPenId) =>
                    patchCategory(cat.code, {
                      colorPenId,
                      ...(colorPenId
                        ? { color: resolvePenColor(project, colorPenId), lw: resolvePenWeight(project, colorPenId) }
                        : {}),
                    })
                  }
                />
              </EditorField>
              <EditorField label={t("editor.lineWeight")}>
                <span className="editor-num">
                  <input
                    type="number"
                    step={0.01}
                    min={0.01}
                    value={cat.lw}
                    disabled={!!cat.colorPenId}
                    onChange={(e) =>
                      patchCategory(cat.code, { lw: Number(e.target.value) })
                    }
                  />
                  <span className="editor-unit">{t("editor.unit.mm")}</span>
                </span>
              </EditorField>
              <EditorField label={t("editor.hatch")}>
                <span className="editor-hatch">
                  <select
                    value={cat.hatch ?? ""}
                    onChange={(e) =>
                      patchCategory(cat.code, {
                        hatch: e.target.value || undefined,
                      })
                    }
                  >
                    <option value="">{t("resources.viewHatch.none")}</option>
                    {project.hatches.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                  {cat.hatch &&
                    (() => {
                      const h = project.hatches.find((ht) => ht.id === cat.hatch);
                      return h ? <HatchSwatch hatch={h} size={26} /> : null;
                    })()}
                </span>
              </EditorField>
            </InlineEditor>
          );
        })()}

      {editor?.kind === "level" &&
        (() => {
          const level = project.drawingLevels.find((z) => z.id === editor.id);
          if (!level) return null;
          const isFloor = level.kind === "floor";
          return (
            <InlineEditor
              x={editor.x}
              y={editor.y}
              title={level.name}
              onClose={() => setEditor(null)}
            >
              <EditorField label={t("editor.name")}>
                <input
                  type="text"
                  value={level.name}
                  autoFocus
                  onChange={(e) => patchLevel(level.id, { name: e.target.value })}
                />
              </EditorField>
              {isFloor && (
                <>
                  <EditorField label={t("editor.floorHeight")}>
                    <span className="editor-num">
                      <input
                        type="number"
                        step={0.05}
                        min={0}
                        value={level.floorHeight ?? 0}
                        onChange={(e) =>
                          patchLevel(level.id, {
                            floorHeight: Number(e.target.value),
                          })
                        }
                      />
                      <span className="editor-unit">{t("editor.unit.m")}</span>
                    </span>
                  </EditorField>
                  <EditorField label={t("editor.cutHeight")}>
                    <span className="editor-num">
                      <input
                        type="number"
                        step={0.05}
                        min={0}
                        value={level.cutHeight ?? 0}
                        onChange={(e) =>
                          patchLevel(level.id, {
                            cutHeight: Number(e.target.value),
                          })
                        }
                      />
                      <span className="editor-unit">{t("editor.unit.m")}</span>
                    </span>
                  </EditorField>
                  {/* Ansichtsbereich ([36]): leer = unbegrenzt (Darstellung wie bisher). */}
                  {(["viewTop", "viewBottom", "viewDepth"] as const).map((k) => (
                    <EditorField key={k} label={t(`editor.${k}`)}>
                      <span className="editor-num">
                        <input
                          type="number"
                          step={0.1}
                          min={k === "viewDepth" ? 0 : undefined}
                          data-testid={`level-${k}`}
                          value={level[k] ?? ""}
                          placeholder="∞"
                          onChange={(e) =>
                            patchLevel(level.id, {
                              [k]: e.target.value === "" ? undefined : Number(e.target.value),
                            })
                          }
                        />
                        <span className="editor-unit">{t("editor.unit.m")}</span>
                      </span>
                    </EditorField>
                  ))}
                </>
              )}
              {!isFloor && (
                <div className="editor-note">
                  {level.kind === "drawing"
                    ? t("editor.noHeightDrawing")
                    : t("editor.noHeightSection")}
                </div>
              )}
            </InlineEditor>
          );
        })()}

      {/* Nicht-blockierende Kurzmeldungen (Ersatz für window.alert, siehe
          notifySlice.ts) — top-level, damit sie über allen Docks/Modals liegen. */}
      <Toast />
    </div>
  );
}
