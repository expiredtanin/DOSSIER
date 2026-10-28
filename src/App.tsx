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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collectVisibleCodes,
  flattenCategories,
} from "./model/types";
import type {
  Ceiling,
  ContextObject,
  Drawing2D,
  DrawingLevel,
  Layout,
  Project,
  Roof,
  Vec2,
  Wall,
} from "./model/types";
import { activePenSet, resolvePenColor, resolvePenWeight } from "./model/penSets";
import { PenColorField } from "./ui/PenColorField";
import { generatePlan, computeKennzahlen, checkRoomProgram } from "./core";
import { programStatusLabel } from "./panels/KennzahlenSection";
import type { CategoryDisplayResolver } from "./core";
import { sectionPlaneFromLevel, sectionUAxisModel } from "./core";
import { roofBaseElevation, roofGeometry } from "./core";
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
import { stepTextToImportedMeshes } from "./io/stepImport";
import { formatIfcReport, ifcBytesToImportedMeshes } from "./io/ifcImport";
import { formatIfcElementsSummary, ifcElementsToProject, readIfcElements } from "./io/ifcElements";
import { IfcImportDialog, type IfcImportMode } from "./ui/IfcImportDialog";
import { projectGeoOrigin } from "./model/geoRebase";
import { applyClashMarkers, runClashCheck } from "./analysis/clash";
import { checkForUpdate } from "./update/checkForUpdate";
import type { PlanViewHandle } from "./views/plan/PlanView";
import type { DisplayResolver } from "./viewport/Viewport3D";
import {
  neighbor3dVertex,
  bodyMoveAnchor,
  hudFromAnchor,
  grip3dTargetKey,
  grip3dEditPoint,
  cycleGrip3dEditState,
  nextGrip3dEditState,
  grip3dEditFields,
  type Grip3dTarget,
  type Grip3dEditState,
} from "./viewport/grip3dHud";
import { ResourceManager } from "./ui/ResourceManager";
import type { ResourceManagerHandlers, TabId as ResourceTabId } from "./ui/ResourceManager";
import { LayoutSheetView } from "./ui/LayoutSheet";
import {
  createViewport,
  createAnnotation,
  addViewport as addViewportToLayout,
  removeViewport as removeViewportFromLayout,
  patchViewport as patchViewportInLayout,
  addAnnotation as addAnnotationToLayout,
  removeAnnotation as removeAnnotationFromLayout,
  patchAnnotation as patchAnnotationInLayout,
} from "./model/layoutModel";
import { HatchSwatch } from "./ui/hatchPreview";
import { TopBar, ViewRibbonTab } from "./ui/TopBar";
import { AppMenuBar } from "./ui/AppMenuBar";
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
import { markSessionClean, markSessionStart } from "./state/startupGuard";
import { getTool } from "./tools/tools";
import { computeSnap } from "./tools/snapping";
import {
  requiredPoints,
  transformPreview,
  rotateGizmoShapes,
} from "./tools/transform";
import type { CopyMode, TransformOp, TransformSelection } from "./tools/transform";
import type {
  SnapResult,
  ToolContext,
  ToolDraft,
  ToolHandlers,
  ToolId,
  ToolMods,
  ToolPointer,
  ToolState,
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
import { useDrawingToolState } from "./state/useDrawingToolState";
import { useSelectionState } from "./state/useSelectionState";
import { useGripEditing } from "./state/useGripEditing";
import { usePanelHostBase } from "./state/usePanelHostBase";
import { useDockDragState } from "./state/useDockDragState";
import { useMouseSelectionHandlers } from "./state/useMouseSelectionHandlers";
import { addNewElementsToActiveGroup, containingGroupId, EMPTY_MEMBERSHIP } from "./state/groupActions";
import type { GroupMembership, MemberKind } from "./state/groupActions";
import { isLocked, setLockedForMembers } from "./state/objectLock";
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
import type { CommandLineHandle, CommandLineField, CommandLineOption } from "./ui/CommandLine";
import { CommandEngine } from "./commands/engine";
import { loadAliasOverrides, saveAliasOverrides } from "./state/commandAliasOverrides";
import {
  loadShortcutOverrides,
  saveShortcutOverrides,
  type ShortcutOverrides,
} from "./state/keyboardShortcuts";
import type { EngineHost, EngineMods } from "./commands/engine";
import type { CommandContext } from "./commands/types";
import { t, useT } from "./i18n";
import {
  cutSegment,
  nearestEdgeIndex,
  splitDrawing,
  toPolyForm,
} from "./editors/splitJoin";
import type { PolyForm } from "./editors/splitJoin";
import {
  countClosedAreas,
  differenceDrawings,
  intersectionDrawings,
  unionDrawings,
} from "./editors/booleanOps";
import type { BooleanResult } from "./editors/booleanOps";
import { applyDrawingStyle, readDrawingStyle } from "./editors/matchProps";

// Globaler Store (Slices: project/selection/view/layout).
import { useStore } from "./state/appStore";
import { categoryLabel, findCategory } from "./state/projectSlice";
import { reconcileLayout } from "./state/layoutSlice";

// Panel-System.
import { Dock } from "./panels/Dock";
import { FloatingPanel } from "./panels/FloatingPanel";
import { DragOverlay } from "./panels/panelDrag";
import { itemDisplay } from "./panels/displayMode";
import { PanelHostContext } from "./panels/types";
import { hostWithMode } from "./panels/host";
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
 * GUI-Werkzeug → Befehlsname der Engine. Die Zeichen-Werkzeuge der Palette sind
 * in Wahrheit Engine-Befehle: ein Klick auf das Werkzeug startet diesen Befehl
 * (statt das Legacy-Tool zu fahren). „select" hat (noch) keinen Befehl und bleibt
 * der Auswahl-Modus. „wall" ist jetzt ebenfalls ein Befehl (`wall`) — Klick und
 * getipptes „wall"/„wand" münden in denselben Befehl; der Legacy-Wand-Pfad ist
 * damit deaktiviert (siehe toolHandlers/onSelectTool).
 */
const TOOL_COMMAND: Partial<Record<ToolId, string>> = {
  wall: "wall",
  ceiling: "ceiling",
  window: "fenster",
  door: "tuer",
  stair: "stair",
  room: "room",
  line: "line",
  xline: "xline",
  ray: "ray",
  polyline: "polyline",
  rect: "rect",
  circle: "circle",
  arc: "arc",
  ellipse: "ellipse",
  polygon: "polygon",
  block: "block",
  spline: "spline",
  bezier: "bezier",
  dimension: "dimension",
  kote: "kote",
  detailref: "detailref",
  scalebar: "scalebar",
  revcloud: "revcloud",
  pointmarker: "pointmarker",
  wipeout: "wipeout",
  text: "text",
  leader: "leader",
  textpath: "textpath",
  textbox: "textbox",
};
/** Befehlsname für ein gekoppeltes Werkzeug (oder null, wenn keiner). */
function coupledCommandFor(id: ToolId): string | null {
  return TOOL_COMMAND[id] ?? null;
}

/**
 * Auswahl für Transformationen/Befehle: im Schnitt/in der Ansicht nur die
 * 2D-Elemente der Ebene. Bauteile (Wand/Decke/…) sind dort zwar anwählbar
 * (Objekt-Info, Löschen), leben aber im Grundriss-Raum — ein im Schnitt-Blatt
 * gemessenes Delta/Drehzentrum würde sie an eine falsche Stelle setzen.
 */
function sheetOnlySelection(level: DrawingLevel, sel: TransformSelection): TransformSelection {
  if (level.kind !== "section" && level.kind !== "elevation") return sel;
  return {
    wallIds: [],
    drawingId: sel.drawingId,
    drawingIds: sel.drawingIds,
    extrudedSolidId: null,
    columnId: null,
    ceilingIds: [],
    roofIds: [],
    stairIds: [],
    roomIds: [],
  };
}

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
  const notify = useStore((s) => s.notify);
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
    liveScale,
    setLiveScale,
    selectedViewSnapshotId,
    setSelectedViewSnapshotId,
    zoomPercent,
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
    toolStateRef,
    draft,
    setDraft,
    activeTransform,
    setActiveTransform,
    transformDragInfoRef,
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

  // Gewählte Annotation auf einem offenen Layout-Blatt (Linie/Rechteck/Text/
  // Bild) — gehoben aus LayoutSheetView, damit die Attribute-Palette (rechtes
  // Panel) dieselbe Auswahl sieht wie ein Drawing2D im Grundriss.
  const [selectedLayoutAnnotationId, setSelectedLayoutAnnotationId] = useState<string | null>(
    null,
  );

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
  // liest die Datei als Text und reicht sie durch parseDxf → addContextObjects.
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
  // Auf die Modus-Map abonnieren, damit App bei einer Moduswahl re-rendert und
  // die abgeleiteten Resolver (floorDisplay/categoryDisplay) neu berechnet.
  const displayModes = useStore((s) => s.displayModes);
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

  // Sichtbare Kategorie-Codes — Basisfilter für Grundriss & 3D.
  const visibleCodes = useMemo(
    () => collectVisibleCodes(project.layers),
    [project.layers],
  );

  // ── ToolController (Zeichenwerkzeuge) ─────────────────────────────────────
  // PlanView meldet rohe Modellpunkte + Pixel/Meter hierher; wir snappen, fahren
  // das aktive Werkzeug (Zustand in toolStateRef, kein Re-Render je Bewegung) und
  // halten den Draft (Vorschau) im State. Commit läuft immutabel über setProject.
  const toolCtx: ToolContext = useMemo(
    () => ({
      project,
      level: activeLevel,
      defaultCategoryCode: activeCategoryCode,
      activeWallTypeId,
      activeLineStyleId,
    }),
    [project, activeLevel, activeCategoryCode, activeWallTypeId, activeLineStyleId],
  );

  // Beim Werkzeugwechsel / Geschoss-/Ansichtswechsel: laufenden Entwurf +
  // laufende Transformation verwerfen.
  useEffect(() => {
    toolStateRef.current = getTool(activeTool).init();
    setDraft(null);
    setActiveTransform(null);
  }, [activeTool, activeLevelId, viewType]);

  // Snap-Kandidaten brauchen die bereits gesetzten Punkte + den letzten Punkt aus
  // dem laufenden Werkzeug-Zustand (Wand: points[], Linie: a).
  const draftPointsFromState = (st: ToolState): Vec2[] => {
    const s = st as { points?: Vec2[]; a?: Vec2 };
    if (s.points) return s.points;
    if (s.a) return [s.a];
    return [];
  };

  const snapFor = (raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
    const pts = draftPointsFromState(toolStateRef.current);
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

  // Wendet ein ToolResult an: Draft (+ Snap-Marker) zeigen, ggf. committen/abschließen.
  const applyToolResult = (
    res: { draft: ToolDraft | null; commit?: (p: Project) => Project; done?: boolean },
    snapResult: ReturnType<typeof snapFor>,
  ) => {
    if (res.draft) setDraft({ ...res.draft, snap: snapResult });
    else if (snapResult) setDraft({ preview: [], vertices: [], snap: snapResult });
    else setDraft(null);
    if (res.commit) setProject(res.commit);
    if (res.done) toolStateRef.current = getTool(activeTool).init();
  };

  const runToolStep = (
    kind: "move" | "click",
    raw: Vec2,
    pxPerMeter: number,
    mods: ToolMods,
  ) => {
    const tool = getTool(activeTool);
    const snapResult = snapFor(raw, pxPerMeter, mods);
    const p: ToolPointer = {
      raw,
      snap: snapResult,
      point: snapResult?.point ?? raw,
      shift: mods.shift,
      ctrl: mods.ctrl,
      alt: mods.alt,
      button: 0,
    };
    const [st, res] =
      kind === "click"
        ? tool.onClick(toolStateRef.current, p, toolCtx)
        : tool.onMove(toolStateRef.current, p, toolCtx);
    toolStateRef.current = st;
    applyToolResult(res, snapResult);
  };

  // ── Transformation (Bewegen/Spiegeln/Drehen) auf der Auswahl ──────────────
  // Trägt ALLE von der Transform-Engine unterstützten Elementarten (Wände, 2D-
  // Zeichnungen, extrudierte Körper, Stützen, Decken/Dächer/Treppen/Räume) —
  // sonst wirken die Kürzel m/s/d nur auf einen Teil dessen, was
  // `commitTransform` tatsächlich bewegt.
  const transformSel: TransformSelection = sheetOnlySelection(activeLevel, {
    wallIds: selectedWallIds,
    drawingId: selectedDrawingId,
    drawingIds: selectedDrawingIds,
    extrudedSolidId: selectedExtrudedSolidId,
    columnId: selectedColumnId,
    ceilingIds: selectedCeilingIds,
    roofIds: selectedRoofIds,
    stairIds: selectedStairIds,
    roomIds: selectedRoomIds,
  });
  const snapForTransform = (raw: Vec2, pxPerMeter: number, mods: ToolMods, points: Vec2[]) =>
    computeSnap({
      raw,
      project,
      levelId: activeLevel.id,
      visibleCodes,
      settings: snap,
      draftPoints: points,
      lastPoint: points.length ? points[points.length - 1] : null,
      pxPerMeter,
      shift: mods.shift,
      ctrl: mods.ctrl,
    });
  const transformMove = (raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
    const tr = activeTransform!;
    const snapResult = snapForTransform(raw, pxPerMeter, mods, tr.points);
    const cursor = snapResult?.point ?? raw;
    // Letzter gesnappter Cursor — speist das Live-Feld (Winkel/Distanz) der
    // Befehlszeile, analog zu gripDragInfoRef beim Vertex-Drag.
    transformDragInfoRef.current = { cursor };
    const need = requiredPoints(tr.op);
    const eff = [...tr.points, cursor].slice(0, need);
    const preview =
      eff.length === need
        ? transformPreview(project, transformSel, tr.op, eff, tr.copyMode, tr.count)
        : [];
    // Dreh-Gizmo (Radius-Kreis + Referenz-/Winkel-Strahl) ZUSÄTZLICH zur
    // transformierten Vorschau, sobald Zentrum+Referenzpunkt stehen und der
    // dritte Punkt (Winkel) noch läuft — Nutzer-Wunsch „bei Drehen auch eine
    // Darstellung". Über denselben `preview`-Kanal wie oben → zeichnet sich
    // automatisch in 2D UND 3D (s. `tools/transform.ts::rotateGizmoShapes`-Doc).
    const gizmo =
      tr.op === "rotate" && tr.points.length === 2
        ? rotateGizmoShapes(tr.points[0], tr.points[1], cursor)
        : [];
    // `hud.at` positioniert die Cursor-HUD-Box (Werte selbst kommen aus
    // `transformFields()`/`hudFields`, s. o. — Nutzer-Wunsch „bei Drehen auch
    // eine Darstellung"); ohne `hud` bliebe die Box unsichtbar (2D UND 3D),
    // auch wenn `hudFields` bereits gültige Felder liefert.
    setDraft({
      preview: [...preview, ...gizmo],
      vertices: tr.points,
      snap: snapResult,
      hud: { at: cursor },
    });
  };
  const transformClick = (raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
    const tr = activeTransform!;
    const snapResult = snapForTransform(raw, pxPerMeter, mods, tr.points);
    const pt = snapResult?.point ?? raw;
    const points = [...tr.points, pt];
    if (points.length >= requiredPoints(tr.op)) {
      commitTransformOn(transformSel, tr.op, points, tr.copyMode, tr.count);
      setActiveTransform(null);
      setDraft(null);
      transformDragInfoRef.current = null;
    } else {
      setActiveTransform({ ...tr, points });
    }
  };

  const toolHandlers: ToolHandlers = {
    onToolMove: (raw, pxPerMeter, mods) => {
      // Läuft ein Befehl, übernimmt die Engine die Plan-Eingabe (ein Eingabepfad).
      // Modifikatoren (Shift=Ortho, Ctrl=Snap aus) mitgeben, damit auch der ERSTE
      // Punkt sauber snappt bzw. unterdrückt werden kann.
      if (engineRef.current?.isActive()) {
        engineRef.current.move(raw, { shift: mods.shift, ctrl: mods.ctrl });
        return;
      }
      // Gekoppeltes Werkzeug (Wand/Linie/Rechteck/Polylinie) ohne laufenden
      // Befehl: KEIN Legacy-Zeichnen — nur Hover (die Engine startet beim Klick neu).
      if (coupledCommandFor(activeTool)) return;
      activeTransform
        ? transformMove(raw, pxPerMeter, mods)
        : runToolStep("move", raw, pxPerMeter, mods);
    },
    onToolClick: (raw, pxPerMeter, mods) => {
      const em = { shift: mods.shift, ctrl: mods.ctrl };
      if (engineRef.current?.isActive()) {
        engineRef.current.pick(raw, em);
        return;
      }
      // Gekoppeltes Werkzeug, aber der Befehl ist (nach Commit) beendet: denselben
      // Befehl neu starten und den Klick als ersten Punkt durchreichen — so bleibt
      // das Werkzeug wie in einem CAD armiert, ohne dass der Legacy-Pfad zeichnet.
      // Der erste Punkt snappt so ebenfalls (mods durchgereicht).
      const cmd = coupledCommandFor(activeTool);
      if (cmd) {
        engineRef.current?.start(cmd);
        engineRef.current?.pick(raw, em);
        return;
      }
      activeTransform
        ? transformClick(raw, pxPerMeter, mods)
        : runToolStep("click", raw, pxPerMeter, mods);
    },
    onToolCommit: () => {
      // Rechtsklick im Viewport = Enter an die Engine (§2.3), wenn ein Befehl läuft.
      if (engineRef.current?.isActive()) {
        engineRef.current.confirm();
        return;
      }
      if (activeTransform) {
        // Rechts-/Doppelklick während einer Transformation = abbrechen.
        setActiveTransform(null);
        setDraft(null);
        return;
      }
      const tool = getTool(activeTool);
      const [st, res] = tool.onCommitGesture(toolStateRef.current, toolCtx);
      toolStateRef.current = st;
      if (res.commit) setProject(res.commit);
      setDraft(null);
      if (res.done) toolStateRef.current = tool.init();
    },
    draft,
  };

  // ── Command-Engine (Rhino-artiges Befehlssystem) ──────────────────────────
  // Eine stabile Engine-Instanz; alle Live-Werte (Kontext/Snap/visibleCodes)
  // liest der Host über einen jeweils aktualisierten `latest`-Ref, damit die
  // Instanz nicht je Render neu gebaut werden muss. Die Engine speist Picks +
  // getippte Eingabe in DENSELBEN Schritt (ein Eingabepfad). Koexistenz: läuft
  // ein Befehl, übernimmt er die linke Maustaste der Plan-Ansicht über denselben
  // toolHandlers-Pfad wie die Alt-Tools (siehe unten).
  const cmdLatest = useRef({
    project,
    activeLevel,
    activeCategoryCode,
    activeLineStyleId,
    activeWallTypeId,
    visibleCodes,
    snap,
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
    setProject,
    setDraft,
  });
  cmdLatest.current = {
    project,
    activeLevel,
    activeCategoryCode,
    activeLineStyleId,
    activeWallTypeId,
    visibleCodes,
    snap,
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
    setProject,
    setDraft,
  };
  const commandLineRef = useRef<CommandLineHandle>(null);
  const engineRef = useRef<CommandEngine | null>(null);
  if (engineRef.current === null) {
    const host: EngineHost = {
      context: (lastPoint): CommandContext => {
        const c = cmdLatest.current;
        return {
          project: c.project,
          level: c.activeLevel,
          defaultCategoryCode: c.activeCategoryCode,
          activeLineStyleId: c.activeLineStyleId,
          activeWallTypeId: c.activeWallTypeId,
          lastPoint,
          // Vorab gesetzte Auswahl aus dem Store (Rhino: erst selektieren, dann
          // Befehl). Move/Copy/Offset operieren darauf.
          // Im Schnitt/in der Ansicht nur die 2D-Elemente der Ebene: Bauteile
          // leben im Grundriss-Raum, ein Schnitt-Delta wäre dort falsch.
          selection: sheetOnlySelection(c.activeLevel, {
            wallIds: c.selectedWallIds,
            drawingId: c.selectedDrawingId,
            drawingIds: c.selectedDrawingIds,
            extrudedSolidId: c.selectedExtrudedSolidId,
            columnId: c.selectedColumnId,
            ceilingIds: c.selectedCeilingIds,
            roofIds: c.selectedRoofIds,
            stairIds: c.selectedStairIds,
            roomIds: c.selectedRoomIds,
          }),
        };
      },
      snap: (raw, draftPoints, mods) => {
        const c = cmdLatest.current;
        return computeSnap({
          raw,
          project: c.project,
          levelId: c.activeLevel.id,
          visibleCodes: c.visibleCodes,
          settings: c.snap,
          draftPoints,
          lastPoint: draftPoints.length ? draftPoints[draftPoints.length - 1] : null,
          pxPerMeter: planViewRef.current?.pxPerMeter() ?? 90,
          // Shift = Ortho, Ctrl = Snap aus — auch für den ERSTEN Punkt (ohne
          // Draft): so fängt der Startpunkt einer neuen Linie/Polylinie/Wand an
          // vorhandene Endpunkte/Mitten, statt erst ab dem zweiten Punkt.
          shift: mods?.shift ?? false,
          ctrl: mods?.ctrl ?? false,
        });
      },
      pxPerMeter: () => planViewRef.current?.pxPerMeter() ?? 90,
      setDraft: (d) => cmdLatest.current.setDraft(d),
      // Zeichnet man WÄHREND man eine Gruppe betreten hat (Isolation), wird
      // das neue Element automatisch Mitglied dieser Gruppe (Nutzer-Wunsch:
      // „wenn man etwas neu zeichnet ... zeichnet man in der Gruppe") — s.
      // state/groupActions.ts::addNewElementsToActiveGroup (Diff vor/nach
      // Commit über alle Elementarten, additiv zur eigentlichen Mutation).
      commit: (mutate) =>
        cmdLatest.current.setProject((p) =>
          addNewElementsToActiveGroup(p, mutate(p), cmdLatest.current.groupPath),
        ),
      isFloor: () => cmdLatest.current.activeLevel.kind === "floor",
      // Frisch über `text`/`textbox` erzeugtes Element sofort inline editieren
      // (kein Lookup nötig — der Commit hat es bereits angehängt, s. engine.ts
      // applyResult-Reihenfolge commit→focusDrawing). Auswahl-Löschen wie
      // onEditDrawingText (useMouseSelectionHandlers.ts), damit kein anderes
      // Element gleichzeitig markiert bleibt.
      focusDrawing: (id, minHeightM) => {
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
        setSelectedDrawingId(id);
        setEditTextMinHeightM(minHeightM ?? null);
        setEditTextId(id);
      },
    };
    engineRef.current = new CommandEngine(host);
  }
  const engine = engineRef.current;

  // Nutzer-Kürzel-Übersteuerungen (Einstellungen → Remap) — aus localStorage
  // geladen, bei jeder Änderung sofort an die Engine gereicht (s. `commands/
  // engine.ts::setAliasOverrides`, `state/commandAliasOverrides.ts`).
  const [aliasOverrides, setAliasOverridesState] = useState<Record<string, string>>(() =>
    loadAliasOverrides(),
  );
  useEffect(() => engine.setAliasOverrides(aliasOverrides), [engine, aliasOverrides]);
  const setAliasOverrides = (next: Record<string, string>) => {
    setAliasOverridesState(next);
    saveAliasOverrides(next);
  };
  // Ändert das native Einstellungs-Fenster (separates Tauri-Fenster) die
  // Kürzel, landen sie zwar in localStorage, aber das `storage`-Event feuert
  // NIE im Fenster, das selbst geschrieben hat — nur in den ANDEREN Fenstern
  // (Web-Storage-API-Standardverhalten). Genau der Fall hier: dieses
  // (Haupt-)Fenster empfängt die Änderung darüber und zieht sie nach.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "cad.commandAliasOverrides") setAliasOverridesState(loadAliasOverrides());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Nutzer-Übersteuerungen der echten Tastatur-Shortcuts (Einstellungen →
  // Tastenkürzel) — analoges Muster zu `aliasOverrides` oben, aber für
  // `state/keyboardShortcuts.ts` (Ctrl/Cmd+Z usw.) statt der Befehlszeilen-
  // Kürzel. Direkt an alle betroffenen Hooks unten durchgereicht.
  const [shortcutOverrides, setShortcutOverridesState] = useState<ShortcutOverrides>(() =>
    loadShortcutOverrides(),
  );
  const setShortcutOverrides = (next: ShortcutOverrides) => {
    setShortcutOverridesState(next);
    saveShortcutOverrides(next);
  };
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "dossier.keyboardShortcutOverrides") {
        setShortcutOverridesState(loadShortcutOverrides());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Auf Engine-Zustandsänderungen re-rendern (Prompt/Optionen aktualisieren).
  const [engineTick, setEngineTick] = useState(0);
  useEffect(
    () => engine.subscribe(() => setEngineTick((n) => n + 1)),
    [engine],
  );
  // engineTick wird nur als Re-Render-Trigger gelesen (kein direkter Konsum).
  void engineTick;
  const engineView = engine.view();
  const commandActive = engineView.active;
  // Fokus wieder freigeben, sobald ein Befehl fertig ist (Commit ODER Abbruch):
  // beim Start wird das Befehlsfeld fokussiert (onSelectTool), bliebe es das
  // auch danach, würde die nächste Zifferntaste im (inaktiven) Feld landen
  // statt beim globalen Werkzeug-Kürzel anzukommen — Esc wäre nötig. Mit dem
  // Blur bei aktiv→inaktiv wählt man wie in Vectorworks sofort das nächste
  // Werkzeug per Zifferntaste, ohne dazwischen Esc zu drücken.
  const prevCommandActiveRef = useRef(commandActive);
  useEffect(() => {
    if (prevCommandActiveRef.current && !commandActive) {
      commandLineRef.current?.blur();
    }
    prevCommandActiveRef.current = commandActive;
  }, [commandActive]);
  // Live-Echo des Befehlszeilen-Texts fürs Cursor-HUD: der getippte Wert
  // erscheint sofort im aktiven Tab-Feld am Cursor (VW-Verhalten).
  const [cmdTyped, setCmdTyped] = useState("");

  // ── GUI-Werkzeug ↔ Befehls-Engine (ein Eingabe-Hub) ───────────────────────
  // Ein Klick auf ein gekoppeltes Zeichen-Werkzeug (Wand/Linie/Rechteck/Polylinie)
  // STARTET den passenden Befehl in der Engine und fokussiert das Befehlsfeld
  // („Dialog drin"). „Auswahl" beendet einen laufenden Befehl (Auswahl-Modus).
  // Zeichenwerkzeuge, die auf einem offenen Layout-Blatt sinnvoll sind (Markups
  // in Papier-mm, s. LayoutSheet.tsx `annotToolFromGlobal`) — dieselben Tool-IDs
  // wie im Grundriss, KEIN eigenes Werkzeug nur fürs Layout (Nutzer-Feedback).
  const LAYOUT_ANNOT_TOOLS: ToolId[] = ["line", "rect", "text", "textbox", "image"];

  const onSelectTool = (id: ToolId) => {
    // Erneuter Klick auf das bereits AKTIVE Werkzeug schaltet zurück auf
    // „Auswahl" (Nutzer-Wunsch) — statt das Werkzeug einfach neu zu starten.
    if (id !== "select" && id === activeTool) id = "select";
    if (activeLayout) {
      // Ein Layout-Blatt ist offen: PlanView/die Befehls-Engine haben keinen
      // sichtbaren Canvas (LayoutSheetView ersetzt die Mitte) — Zeichenwerkzeuge
      // wertet dort `activeTool` direkt aus (Klick + ggf. Datei-Dialog fürs
      // Bild), alles andere (Wand/Raum/… — auf dem Blatt ohne Bedeutung) fällt
      // auf „Auswahl" zurück statt eine Befehls-Engine ohne Canvas zu starten.
      setActiveTool(LAYOUT_ANNOT_TOOLS.includes(id) ? id : "select");
      return;
    }
    if (id === "image") {
      // Datei-Auswahl ist async (Dateidialog) — kein Klick-Platzieren wie bei
      // den übrigen Zeichen-Werkzeugen, daher hier abgefangen statt über die
      // Befehls-Engine/`activeTool` zu laufen (s. tools.ts `imageTool`-Kommentar).
      imageInputRef.current?.click();
      return;
    }
    const cmd = coupledCommandFor(id);
    if (cmd) {
      // Den gekoppelten Befehl in DERSELBEN Engine starten wie das Tippen von
      // „line" — Klick und Tippen münden in denselben Befehl. Das aktive-Tool-
      // Highlight spiegelt den laufenden Befehl (activeTool = id). Der Legacy-
      // Zeichenpfad ist deaktiviert, solange ein Befehl läuft (toolHandlers
      // leiten Move/Pick/Confirm an die Engine, siehe oben).
      engine.start(cmd);
      setActiveTool(id);
      // Befehlsfeld fokussieren: getippte Präzisionseingabe steht sofort bereit.
      // Nach dem Render des aktiven Prompts fokussieren (nächster Tick).
      requestAnimationFrame(() => commandLineRef.current?.focus());
      return;
    }
    // „Auswahl" oder ein Legacy-Werkzeug (Wand): laufenden Befehl beenden.
    if (engine.isActive()) engine.cancel();
    setActiveTool(id);
  };

  // Ribbon-Befehl (Ändern-Gruppe u. a.): startet einen Engine-Befehl OHNE
  // eigenes Werkzeug (kein ToolId). Läuft über DIESELBE Engine wie das Tippen des
  // Befehls; das Werkzeug-Highlight fällt auf „Auswahl" zurück, das Aktiv-
  // Highlight des Ribbon-Befehls spiegelt der laufende Befehl (engineView).
  // Interaktive Transformation (Bewegen/Spiegeln/Drehen) auf der Auswahl starten —
  // derselbe U/I/O/P-Pfad (`activeTransform`) wie die Kürzel m/s/d, nur von Button/
  // Befehlszeile ausgelöst. Ohne transformierbare Auswahl ein kurzer Hinweis.
  const startTransformOp = (op: TransformOp) => {
    const hasSel =
      selectedWallIds.length > 0 ||
      !!selectedDrawingId ||
      selectedDrawingIds.length > 0 ||
      !!selectedExtrudedSolidId ||
      !!selectedColumnId ||
      selectedCeilingIds.length > 0 ||
      selectedRoofIds.length > 0 ||
      selectedStairIds.length > 0 ||
      selectedRoomIds.length > 0;
    if (!hasSel) {
      notify(t("transform.needSelection"), "info");
      return;
    }
    setActiveTool("select");
    setActiveTransform({ op, copyMode: "move", count: 1, points: [] });
    setDraft(null);
    requestAnimationFrame(() => commandLineRef.current?.focus());
  };
  const onRunCommand = (name: string) => {
    // „rotate" (Drehen) läuft über die interaktive Transformation mit U/I/O/P —
    // nicht über die Befehls-Engine (die kennt kein Rotate-Kommando). So ist der
    // Ribbon-Button der Einstieg in denselben Fluss wie die Taste „d".
    if (name === "rotate") {
      startTransformOp("rotate");
      return;
    }
    engine.start(name);
    setActiveTool("select");
    requestAnimationFrame(() => commandLineRef.current?.focus());
  };

  // 3D-Viewport als Erstellungs-Fläche: der Viewport projiziert den Cursor auf
  // die Geschoss-Arbeitsebene und liefert einen rohen Modell-`Vec2`; wir füttern
  // ihn in DIESELBE ansichts-agnostische CommandEngine wie PlanView (move/pick).
  // Snapping/Tab-Felder/Commit laufen unverändert über den EngineHost; die neuen
  // Elemente landen auf dem aktiven Geschoss (host.context().level).
  const onWorkplanePoint = (kind: "move" | "pick", model: Vec2, mods?: EngineMods) => {
    // Läuft eine interaktive Transformation (m/s/d — Bewegen/Spiegeln/Drehen
    // der Auswahl), hat sie Vorrang — exakt wie `toolHandlers.onToolMove`/
    // `onToolClick` das für den 2D-Plan schon tun (s. o.). Bisher war das hier
    // NICHT verdrahtet: ein Klick im 3D-Viewport während m/s/d tat schlicht
    // nichts, Drehen/Verschieben/Spiegeln funktionierten im 3D also gar nicht
    // (Nutzer-Wunsch „bei Drehen auch eine Darstellung" — die Vorschau kommt
    // jetzt über denselben `draft`-Kanal wie das Zeichnen, s. `transformMove`).
    // 3D hat kein echtes pxPerMeter (Perspektive) — derselbe feste Näherungs-
    // wert wie `snapFor3dVertex` oben.
    if (activeTransform) {
      const toolMods: ToolMods = { shift: !!mods?.shift, ctrl: !!mods?.ctrl, alt: false };
      if (kind === "move") transformMove(model, 90, toolMods);
      else transformClick(model, 90, toolMods);
      return;
    }
    const eng = engineRef.current;
    if (!eng?.isActive()) return;
    if (kind === "move") eng.move(model, mods);
    else eng.pick(model, mods);
  };
  const onWorkplaneConfirm = () => {
    // Rechtsklick-ohne-Drag/Doppelklick im 3D während einer Transformation =
    // abbrechen — dasselbe Verhalten wie `onToolCommit` im 2D-Plan (§ s. o.).
    if (activeTransform) {
      setActiveTransform(null);
      setDraft(null);
      return;
    }
    const eng = engineRef.current;
    if (eng?.isActive()) eng.confirm();
  };

  // Globaler Undo/Redo-Shortcut — siehe state/useKeyboardShortcuts.ts.
  useUndoRedoShortcut(undo, redo, shortcutOverrides);

  // Esc/Enter/Backspace für das aktive Zeichenwerkzeug. Siehe
  // state/useKeyboardShortcuts.ts. Die Zifferntasten-Werkzeugwahl
  // (useToolNumberShortcuts) folgt weiter unten, NACH useGripEditing() — sie
  // braucht dessen gripDragInfoRef, um Zifferntasten während einer Griff-
  // Bearbeitung nicht als Werkzeug-Wechsel misszuverstehen.
  useActiveToolKeys(activeTool, toolCtx, engineRef, toolStateRef, setDraft, setActiveTool, setProject);

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
    // Schnittlinie(n): Entf löscht NUR ihre Linie (linePoints), die Ebene
    // bleibt — ADDITIV zu den übrigen Kanälen unten (nicht mehr exklusiv:
    // seit Cmd/Ctrl+A Schnittlinien zusammen mit Wänden/etc. mitselektiert,
    // würde ein frühes `return` hier die übrigen Kanäle stumm überspringen).
    if (selectedSectionLineIds.length) {
      for (const id of selectedSectionLineIds) patchLevel(id, { linePoints: undefined });
    }
    // Objekt-Sperre: gesperrte Elemente aus der Löschung ausnehmen (s.
    // `moveGrip`/`moveElementBy` in projectSlice.ts für dieselbe Prüfung
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
    setProject((p) => ({
      ...p,
      drawings2d: p.drawings2d.filter((d) => !dids.has(d.id)),
      walls: p.walls.filter((w) => !wids.has(w.id)),
      ceilings: (p.ceilings ?? []).filter((c) => !cids.has(c.id)),
      roofs: (p.roofs ?? []).filter((r) => !rfids.has(r.id)),
      stairs: (p.stairs ?? []).filter((s) => !stids.has(s.id)),
      rooms: (p.rooms ?? []).filter((r) => !rmids.has(r.id)),
      extrudedSolids: (p.extrudedSolids ?? []).filter((s) => !exids.has(s.id)),
      columns: (p.columns ?? []).filter((c) => !colids.has(c.id)),
      // Öffnungen: eigene Auswahl löschen UND alle, deren Host-Wand entfällt.
      openings: (p.openings ?? []).filter(
        (o) => !oids.has(o.id) && !wids.has(o.hostWallId),
      ),
      context: (p.context ?? []).filter((o) => !ctxids.has(o.id)),
    }));
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

  // Tastatur im Auswahl-Werkzeug: Ctrl/Cmd+A = alles wählen, Entf/Backspace =
  // Auswahl löschen — siehe state/useKeyboardShortcuts.ts.
  useSelectAllAndDeleteShortcut({
    activeTool,
    activeTransform,
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
    const idSet = new Set(ids);
    const newIds: string[] = [];
    setProject((p) => {
      const out: typeof p.drawings2d = [];
      for (const d of p.drawings2d) {
        if (!idSet.has(d.id)) {
          out.push(d);
          continue;
        }
        const others: PolyForm[] = [];
        for (const o of p.drawings2d) {
          if (o.id === d.id || o.levelId !== d.levelId) continue;
          const f = toPolyForm(o.geom);
          if (f) others.push(f);
        }
        const pieces = splitDrawing(d, others);
        for (const piece of pieces) newIds.push(piece.id);
        out.push(...pieces);
      }
      return { ...p, drawings2d: out };
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
    setProject((p) => ({
      ...p,
      drawings2d: [
        ...p.drawings2d.filter((d) => !replaced.has(d.id)),
        ...result.created,
      ],
    }));
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
    setProject((p) => applyDrawingStyle(p, selectedDrawingIds, drawingStyleClipboard));
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
    setProject((p) => setLockedForMembers(p, selectionLockMembers, !selectionAllLocked));
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
    setProject((p) => ({ ...p, layers: setCategoriesVisible(p.layers, codes, false) }));
  };
  const isolateSelectionLayers = () => {
    if (selectionLayerCodes.length === 0) return;
    const codes = new Set(selectionLayerCodes);
    setProject((p) => ({ ...p, layers: isolateCategories(p.layers, codes) }));
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
    setProject((p) => ({
      ...p,
      drawings2d: p.drawings2d.map((d) =>
        selectedDrawingIds.includes(d.id) ? { ...d, noPrint: next } : d,
      ),
    }));
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
    setProject,
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
  // gelegene Kante (nearestEdgeIndex) und entfernt sie. Geschlossene Form →
  // offene Polylinie; bleiben <2 Punkte übrig, wird das Element gelöscht.
  const onSegmentCut = (drawingId: string, model: Vec2) => {
    const src = project.drawings2d.find((d) => d.id === drawingId);
    if (!src) return;
    const edgeIndex = nearestEdgeIndex(src.geom, model);
    if (edgeIndex === null) return;
    let removed = false;
    setProject((p) => ({
      ...p,
      drawings2d: p.drawings2d.flatMap((d) => {
        if (d.id !== drawingId) return [d];
        const next = cutSegment(d, edgeIndex);
        if (next === null) {
          removed = true;
          return [];
        }
        return [next];
      }),
    }));
    if (removed) setSelectedDrawingIds([]);
  };

  // Transformations-Shortcuts (m/s/d, U/I/O/P-Modusleiste, „q" Messen) — siehe
  // state/useKeyboardShortcuts.ts.
  useTransformShortcuts(
    activeTool,
    activeTransform,
    setActiveTransform,
    selectedWallIds,
    selectedDrawingId,
    selectedDrawingIds,
    selectedExtrudedSolidId,
    selectedColumnId,
    selectedCeilingIds,
    selectedRoofIds,
    selectedStairIds,
    selectedRoomIds,
    engine,
    setDraft,
    requestCopyCount,
    onRunCommand,
    commandLineRef,
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
    addDrawingLevel,
    importDrawings,
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
    addContextObjects,
    addContextObjectsAndFit,
    removeContextObject,
    removeContextObjects,
    generateTerrain,
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
  } = useProjectActions(setProject, notify, planViewRef);

  // IFC-Import: erst die Wahl Mesh/Bauteile (`IfcImportDialog`), dann [B3] Kontext-Meshes
  // (`io/ifcImport.ts`) oder [B4] echte Bauteile (`io/ifcElements.ts`, übernommen über setProject).
  const [pendingIfc, setPendingIfc] = useState<File | null>(null);
  const importIfcFile = (f: File) => setPendingIfc(f);
  const runIfcImport = (f: File, mode: IfcImportMode) => {
    if (mode === "elements") {
      void f
        .arrayBuffer()
        .then((buf) => readIfcElements(new Uint8Array(buf)))
        .then(({ products, report, elements }) => {
          let summary: ReturnType<typeof ifcElementsToProject>["summary"] | null = null;
          let bounds: { x: number; y: number }[] = [];
          setProject((p) => {
            const r = ifcElementsToProject(p, products, elements, { fileName: f.name, geoOrigin: projectGeoOrigin(p) });
            summary = r.summary;
            const added = new Set(p.walls.map((w) => w.id));
            bounds = r.project.walls.filter((w) => !added.has(w.id)).flatMap((w) => [w.start, w.end]);
            return r.project;
          });
          if (bounds.length) planViewRef.current?.fitBounds(bounds);
          if (summary) {
            const s: ReturnType<typeof ifcElementsToProject>["summary"] = summary;
            const empty = s.walls + s.ceilings + s.columns + s.rooms + s.meshes === 0;
            notify(formatIfcElementsSummary(s, report, t), empty || report.truncated ? "warning" : "info");
          }
        })
        .catch((err) =>
          notify(`${t("ifc.import.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error"),
        );
      return;
    }
    void f
      .arrayBuffer()
      .then((buf) => ifcBytesToImportedMeshes(new Uint8Array(buf), f.name, { geoOrigin: projectGeoOrigin(project) }))
      .then(({ meshes, report }) => {
        if (meshes.length) addContextObjectsAndFit(meshes);
        const warn = meshes.length === 0 || report.truncated || report.productsWithoutGeometry > 0;
        notify(formatIfcReport(report, t), warn ? "warning" : "info");
      })
      .catch((err) =>
        notify(`${t("ifc.import.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error"),
      );
  };
  /** Datei aus Import-Dialog oder Drag & Drop: IFC direkt, sonst DXF/DWG-Dialog. */
  const openImportForAnyFile = (f: File) => {
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
    scaleDenominator,
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
    moveGripOf,
    moveRoomEdge,
    moveCeilingEdge,
    moveEdgeOf,
    moveRoomBy,
    moveCeilingBy,
    moveElementByOf,
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
    setProject,
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
    onSaveProject,
    onNewProject,
    onNewProjectFromSample,
    onNewProjectFromTemplate,
    onProjectTemplateFileChosen,
    applyOpenedProjectFile,
    projectFileName,
    runExport,
    onExportSchedule,
    onExportIfc,
    onExportObj,
    onExportStl,
    onExportStep,
    onOpenProject,
    openProjectAtPath,
    onProjectFileChosen,
    runImport,
  } = useProjectFileActions(
    project,
    setProject,
    setImportState,
    setExportSaveFormat,
    activeCategoryCode,
    addDrawingLevel,
    importDrawings,
    addContextObjects,
    setActiveLevelId,
    planViewRef,
  );

  // Gewählte Layout-Annotation als echtes Objekt (statt nur ihrer Id) — liegt
  // in `Layout.annotations` (Papier-mm), NICHT im Modell, daher separat von
  // `deriveSelection` (die nur Projekt-Bauteile kennt) aufgelöst. Muss VOR
  // `textTarget`/`selection` stehen (beide lesen sie synchron im selben Render).
  const selectedLayoutAnnotation = useMemo(() => {
    if (activeLayoutId === null || !selectedLayoutAnnotationId) return null;
    const layout = (project.layouts ?? []).find((l) => l.id === activeLayoutId);
    return layout?.annotations?.find((a) => a.id === selectedLayoutAnnotationId) ?? null;
  }, [project.layouts, activeLayoutId, selectedLayoutAnnotationId]);

  // Text-Ziel der Oberleisten-Text-Gruppe: der Stempel-Text des (einzeln)
  // gewählten Raums. Ohne aktive Editor-Auswahl wirkt Formatierung auf das ganze
  // Doc (range: null). Ist kein Raum gewählt → null (Controls setzen nur
  // Defaults). Der Setter schreibt live in den Store.
  const textTarget = useMemo(() => {
    if (selectedRoom) {
      return {
        doc: selectedRoom.stampDoc ?? docFromText(selectedRoom.name),
        range: null,
        apply: (doc: RichTextDoc) => setRoomStampDoc(selectedRoom.id, doc),
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
            updateDrawing2D(d.id, { geom: { ...g, ...patch } });
          },
        };
      }
    }
    // Ausgewähltes Text-Markup auf einem offenen Layout-Blatt: wie Raum-Stempel
    // OHNE Grössen-Kopplung ans Modell (Papier-mm-Kontext, `heightMm` ist bereits
    // der Basiswert für Runs ohne eigene `sizePt`) — die Oberleisten-Grösse
    // wirkt hier also normal, anders als bei freiem Grundriss-Text oben.
    if (selectedLayoutAnnotation && selectedLayoutAnnotation.kind === "text" && activeLayoutId !== null) {
      const ann = selectedLayoutAnnotation;
      return {
        doc: ann.doc ?? docFromText(ann.text),
        range: null,
        apply: (newDoc: RichTextDoc) =>
          patchOpenLayout(activeLayoutId, (l) =>
            patchAnnotationInLayout(l, ann.id, { doc: newDoc, text: plainText(newDoc) }),
          ),
      };
    }
    return null;
  }, [
    selectedRoom,
    setRoomStampDoc,
    selectedDrawingId,
    project.drawings2d,
    updateDrawing2D,
    selectedLayoutAnnotation,
    activeLayoutId,
  ]);

  // ── 3D-Editier-Griffe (direkt im Viewport3D) ──────────────────────────────
  // Genau EINE gewählte Wand (kein 2D-Element) bzw. genau EIN 2D-Element liefert
  // die Quelle der 3D-Griffe. Dieselben Store-Actions wie bei den Plan-Griffen
  // (moveGripOf/moveElementByOf), damit Plan + 3D identisch mutieren. Der Höhen-
  // Griff bindet die OK absolut (top=custom z) — gleicher Pfad wie das Attribut-
  // Panel (updateWall top).
  // Alle gewählten Wände/2D-Elemente als Quelle der 3D-Griffe. Wände UND 2D-
  // Elemente schließen sich gegenseitig aus (entweder-oder), damit der einzelne
  // Element-Editierpfad (moveGripOf je ID) eindeutig bleibt. Bei Mehrfachauswahl
  // erscheinen Griffe für ALLE — Basis für das gemeinsame Ziehen koinzidenter Ecken.
  const edit3dWalls = useMemo(
    () =>
      selectedDrawingIds.length === 0
        ? selectedWallIds
            .map((id) => project.walls.find((w) => w.id === id))
            .filter((w): w is Wall => !!w)
        : [],
    [selectedWallIds, selectedDrawingIds, project.walls],
  );
  const edit3dDrawings = useMemo(
    () =>
      selectedWallIds.length === 0
        ? selectedDrawingIds
            .map((id) => project.drawings2d.find((d) => d.id === id))
            .filter((d): d is Drawing2D => !!d)
        : [],
    [selectedWallIds, selectedDrawingIds, project.drawings2d],
  );
  // Gewählte Decken → 3D-Eckpunkt-/Kanten-/Verschiebe-Griffe. Nur wenn keine
  // Wände/2D-Elemente mitselektiert sind (eindeutiger Editierfokus).
  const edit3dCeilings = useMemo(
    () =>
      selectedWallIds.length === 0 && selectedDrawingIds.length === 0
        ? selectedCeilingIds
            .map((id) => (project.ceilings ?? []).find((c) => c.id === id))
            .filter((c): c is Ceiling => !!c)
        : [],
    [selectedWallIds, selectedDrawingIds, selectedCeilingIds, project.ceilings],
  );
  // Dächer mit 3D-Griffen: nur wenn ausschliesslich Dächer gewählt sind
  // (Eck-Griffe zum Resizen, Move-Griff, First-Griff für die Neigung).
  const edit3dRoofs = useMemo(
    () =>
      selectedWallIds.length === 0 &&
      selectedDrawingIds.length === 0 &&
      selectedCeilingIds.length === 0
        ? selectedRoofIds
            .map((id) => (project.roofs ?? []).find((r) => r.id === id))
            .filter((r): r is Roof => !!r)
        : [],
    [selectedWallIds, selectedDrawingIds, selectedCeilingIds, selectedRoofIds, project.roofs],
  );
  // Snap beim 3D-Vertex-Drag: dieselbe computeSnap-Logik wie die Plan-Griffe.
  // Das/die gerade GEZOGENEN Element(e) werden aus den Snap-Quellen genommen
  // (sonst fängt der Punkt an sich selbst). `excludeWallIds`/`excludeDrawingIds`
  // sind die Mitglieder der Koinzidenz-Gruppe (alle, die mitgeführt werden).
  const snapFor3dVertex = (
    raw: Vec2,
    excludeWallIds: Set<string>,
    excludeDrawingIds: Set<string>,
  ): SnapResult | null => {
    const snapProject: Project = {
      ...project,
      walls: project.walls.filter((w) => !excludeWallIds.has(w.id)),
      drawings2d: project.drawings2d.filter((d) => !excludeDrawingIds.has(d.id)),
    };
    return computeSnap({
      raw,
      project: snapProject,
      levelId: activeLevel.id,
      visibleCodes,
      settings: snap,
      draftPoints: [],
      lastPoint: null,
      // 3D hat kein echtes pxPerMeter; ein vernünftiger Fallback hält die
      // Snap-Toleranz (tolerancePx/pxPerMeter) in einem brauchbaren Meter-Bereich.
      pxPerMeter: 90,
      shift: false,
      ctrl: false,
    });
  };
  // Cursor-HUD (Länge/Winkel bzw. Δx/Δy) für einen 3D-Griff-Drag — Nutzer-
  // Report „beim Verschieben von Elementen zeigt es die Werte nicht an": die
  // 3D-Griffe (`onEdit3dVertex`/`onEdit3dBody`) mutierten das Modell bisher
  // OHNE je `setDraft(...)` mit einem `hud` zu füllen (anders als die 2D-
  // Griff-Bearbeitung, `state/useGripEditing.ts::hudFor`/`edgeHudFor`, die das
  // von Anfang an tat) — der Cursor-HUD blieb daher leer, obwohl der Kanal
  // (`hudFields`/`draft.hud`, s. `Wasm3DViewport.tsx`) längst bis in den 3D-
  // Viewport durchgereicht ist. Die reine Geometrie (Nachbar-/Anker-Auflösung)
  // lebt in `viewport/grip3dHud.ts` (eigenständig testbar).
  //
  // Läuft während eines „move"-Griff-Drags (ganzes Element verschieben): sammelt
  // die seit Drag-Beginn angewandten Deltas je Ziel-Element, damit das HUD die
  // GESAMTE Verschiebung zeigt statt des winzigen Pro-Event-Deltas. `rawTotal`
  // = reine Maus-Summe (auch bei aktivem Feld-Controller weitergeführt, damit
  // ein entsperrtes Feld sofort wieder der Maus folgt); `appliedTotal` = was
  // TATSÄCHLICH aufs Modell angewandt wurde (kann bei Locks abweichen). Reset
  // bei Ziel-Wechsel (neuer Drag) UND in `onEdit3dEnd` (Drag-Ende).
  const bodyDragRef = useRef<{ key: string; anchor: Vec2; rawTotal: Vec2; appliedTotal: Vec2 } | null>(
    null,
  );
  // Feld-Controller (Tab-Zyklus, getippte Werte) für einen laufenden 3D-Griff-
  // Drag — Nutzer-Report „man sieht Länge/Winkel, aber man kann nichts
  // eingeben". Eigenständiges 3D-Äquivalent zu `useGripEditing.ts`s `gripEdit`
  // (s. `viewport/grip3dHud.ts`-Dateikommentar für das „warum eigenständig").
  const [grip3dEdit, setGrip3dEdit] = useState<Grip3dEditState | null>(null);
  // Letzter bekannter roh (maus-getriebener, UN-gelockter) Zustand des
  // laufenden 3D-Griff-Drags — Grundlage fürs ÖFFNEN des Feld-Controllers
  // (Tab friert die AKTUELLE Position ein, s. `cycleGrip3dEditState`).
  const last3dDragRef = useRef<
    { target: Grip3dTarget; index: number; kind: "vertex" | "move"; anchor: Vec2; raw: Vec2 } | null
  >(null);
  // Ein 3D-Vertex-Griff wurde gezogen. `target` benennt das konkrete Element
  // (Wand-ID ODER Drawing-ID), `index` den Vertex. Liefert den effektiv
  // angewandten (gesnappten) Punkt zurück — der 3D-Viewport nutzt ihn, um
  // koinzidente Endpunkte anderer gewählter Elemente mitzuführen und den
  // Snap-Marker zu zeigen. `snapped=false` (für mitgeführte Geschwister) wendet
  // den Punkt direkt an, ohne erneut zu snappen.
  // Reine Mutations-Anwender OHNE Lock-/Snap-/HUD-Logik — von `onEdit3dVertex`/
  // `onEdit3dBody` (Maus-Pfad) UND `submitGrip3dEditValue` (Tastatur-Pfad)
  // gemeinsam genutzt, damit Letzterer NICHT `onEdit3dVertex`/`onEdit3dBody`
  // rekursiv aufruft — das würde `grip3dEdit`/`bodyDragRef` über einen VERALTETEN
  // Closure-Wert lesen (React-State ist innerhalb desselben Funktionsaufrufs
  // noch nicht aktualisiert) und den gerade getippten Wert wieder verwerfen.
  const applyVertexPoint = (target: Grip3dTarget, index: number, pt: Vec2) => {
    if (target.roofId) moveRoofGrip(target.roofId, index, pt);
    else if (target.ceilingId) moveCeilingGrip(target.ceilingId, index, pt);
    else moveGripOf(target.drawingId ?? null, target.wallId ?? null, index, pt);
  };
  const applyBodyDelta = (target: Grip3dTarget, delta: Vec2) => {
    if (target.roofId) moveRoofBy(target.roofId, delta);
    else if (target.ceilingId) moveCeilingBy(target.ceilingId, delta);
    else moveElementByOf(target.drawingId ?? null, target.wallId ?? null, delta);
  };
  const onEdit3dVertex = (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    index: number,
    model: Vec2,
    excludeWallIds?: Set<string>,
    excludeDrawingIds?: Set<string>,
  ): Vec2 => {
    // Nachbarpunkt VOR der Mutation auflösen (Wand/Zeichnung/Decke/Dach ändern
    // sich hier nur am gezogenen `index`, der Nachbar bleibt stabil).
    const neighbor = neighbor3dVertex(project, target, index);
    let pt = model;
    let snapHit: SnapResult | null = null;
    const ge = grip3dEdit;
    if (
      ge &&
      ge.kind === "vertex" &&
      ge.index === index &&
      grip3dTargetKey(ge.target) === grip3dTargetKey(target) &&
      (ge.locks.length != null || ge.locks.angle != null)
    ) {
      // Feld-Controller aktiv: getippte/eingefrorene Werte übersteuern die
      // Maus — kein Snap währenddessen (deckungsgleich mit 2D `onGripMove`).
      pt = grip3dEditPoint(ge.anchor, ge.locks, model);
    } else if (excludeWallIds || excludeDrawingIds) {
      const snapResult = snapFor3dVertex(
        model,
        excludeWallIds ?? new Set(),
        excludeDrawingIds ?? new Set(),
      );
      pt = snapResult?.point ?? model;
      snapHit = snapResult;
    }
    applyVertexPoint(target, index, pt);
    if (neighbor) last3dDragRef.current = { target, index, kind: "vertex", anchor: neighbor, raw: model };
    setDraft({
      preview: [],
      vertices: [],
      snap: snapHit,
      hud: neighbor ? hudFromAnchor(neighbor, pt) : undefined,
    });
    return pt;
  };
  const onEdit3dBody = (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    delta: Vec2,
    locked = false,
  ) => {
    const key = grip3dTargetKey(target);
    if (!bodyDragRef.current || bodyDragRef.current.key !== key) {
      bodyDragRef.current = {
        key,
        anchor: bodyMoveAnchor(project, target) ?? { x: 0, y: 0 },
        rawTotal: { x: 0, y: 0 },
        appliedTotal: { x: 0, y: 0 },
      };
    }
    const st = bodyDragRef.current;
    st.rawTotal = { x: st.rawTotal.x + delta.x, y: st.rawTotal.y + delta.y };
    const rawPoint: Vec2 = { x: st.anchor.x + st.rawTotal.x, y: st.anchor.y + st.rawTotal.y };
    const ge = grip3dEdit;
    let bodySnap: SnapResult | null = null;
    let desiredPoint: Vec2;
    if (ge && ge.kind === "move" && grip3dTargetKey(ge.target) === key && (ge.locks.length != null || ge.locks.angle != null)) {
      desiredPoint = grip3dEditPoint(ge.anchor, ge.locks, rawPoint);
    } else if (locked) {
      desiredPoint = rawPoint; // Shift/Achs-Sperre hat Vorrang vor dem Einrasten
    } else {
      // Referenzpunkt des Körpers rastet auf andere Punkte ein
      bodySnap = snapFor3dVertex(
        rawPoint,
        new Set(target.wallId ? [target.wallId] : []),
        new Set(target.drawingId ? [target.drawingId] : []),
      );
      desiredPoint = bodySnap?.point ?? rawPoint;
    }
    const desiredTotal: Vec2 = { x: desiredPoint.x - st.anchor.x, y: desiredPoint.y - st.anchor.y };
    const appliedDelta: Vec2 = {
      x: desiredTotal.x - st.appliedTotal.x,
      y: desiredTotal.y - st.appliedTotal.y,
    };
    applyBodyDelta(target, appliedDelta);
    st.appliedTotal = desiredTotal;
    last3dDragRef.current = { target, index: -1, kind: "move", anchor: st.anchor, raw: rawPoint };
    setDraft({
      preview: [],
      vertices: [],
      snap: bodySnap,
      hud: { at: desiredPoint, dx: desiredTotal.x, dy: desiredTotal.y },
    });
  };
  // Tab während eines laufenden 3D-Griff-Drags (Endpunkt ODER Verschieben):
  // Feld-Controller öffnen/zykeln — analog `useGripEditing.ts::
  // cycleGripEditField`, aber auf `last3dDragRef` als Zustandsquelle statt
  // der 2D-Grips-Liste. `Wasm3DViewport.tsx` ruft dies auf einem eigenen
  // Tastatur-Listener auf (nur solange EIN 3D-Griff-Drag läuft — s. dort).
  const cycleGrip3dEditField = () => {
    const info = last3dDragRef.current;
    if (!info) return;
    setGrip3dEdit((prev) => cycleGrip3dEditState(prev, info));
    requestAnimationFrame(() => commandLineRef.current?.focus());
  };
  // Escape während eines laufenden 3D-Griff-Drags: abbrechen. ALLE fünf
  // Griff-Mutationen coalescen ihre Schritte zu GENAU einem Undo-Eintrag pro
  // Drag (s. `state/projectSlice.ts::moveGripOf`/`updateWall`/… -Doc), ein
  // einzelner `undo()` reicht also, um den GESAMTEN Drag zu verwerfen statt
  // nur den letzten Mikro-Schritt. `Wasm3DViewport.tsx` räumt seinen eigenen
  // (lokalen) Drag-Zustand danach selbst auf (`endGripDrag`); hier nur der
  // Modell-Zustand + der App-seitige Aufräum-Teil (`onEdit3dEnd`).
  const cancelGrip3dEdit = () => {
    undo();
    onEdit3dEnd();
  };
  // Getippter Zahlenwert im 3D-Feld-Controller — analog `submitGripEditValue`.
  // Nutzt `applyVertexPoint`/`applyBodyDelta` (NICHT `onEdit3dVertex`/
  // `onEdit3dBody` selbst, s. deren Dateikommentar oben).
  const submitGrip3dEditValue = (value: number) => {
    const ge = grip3dEdit;
    if (!ge) return;
    const next = nextGrip3dEditState(ge, value);
    setGrip3dEdit(next);
    const raw = last3dDragRef.current?.raw ?? next.anchor;
    const pt = grip3dEditPoint(next.anchor, next.locks, raw);
    if (next.kind === "vertex") {
      applyVertexPoint(next.target, next.index, pt);
      last3dDragRef.current = { target: next.target, index: next.index, kind: "vertex", anchor: next.anchor, raw };
      setDraft({ preview: [], vertices: [], snap: null, hud: hudFromAnchor(next.anchor, pt) });
      return;
    }
    const st = bodyDragRef.current;
    if (!st) return;
    const desiredTotal: Vec2 = { x: pt.x - st.anchor.x, y: pt.y - st.anchor.y };
    const appliedDelta: Vec2 = {
      x: desiredTotal.x - st.appliedTotal.x,
      y: desiredTotal.y - st.appliedTotal.y,
    };
    applyBodyDelta(next.target, appliedDelta);
    st.appliedTotal = desiredTotal;
    last3dDragRef.current = { target: next.target, index: -1, kind: "move", anchor: next.anchor, raw };
    setDraft({ preview: [], vertices: [], snap: null, hud: { at: pt, dx: desiredTotal.x, dy: desiredTotal.y } });
  };
  // First-Griff: neue First-Höhe (world-Y = Modell-Höhe) → Dachneigung. Aus der
  // aktuellen Neigung die halbe Spannweite ableiten und daraus den neuen Winkel
  // rechnen (behält die Firstlage, ändert nur die Steilheit).
  const onEdit3dRoofPitch = (roofId: string, apexHeight: number) => {
    const roof = (project.roofs ?? []).find((r) => r.id === roofId);
    if (!roof) return;
    const baseZ = roofBaseElevation(project, roof);
    const geom = roofGeometry(roof, baseZ);
    const currentRidge = geom.ridgeHeight; // Höhe First über Traufe
    const newRidge = Math.max(0.05, apexHeight - baseZ);
    const curPitch = ((roof.pitchDeg ?? 30) * Math.PI) / 180;
    // Halbe Spannweite aus aktueller Geometrie (First/tan(Neigung)).
    const halfSpan = currentRidge > 1e-4 ? currentRidge / Math.tan(curPitch || 1e-3) : 1;
    const newPitch = (Math.atan(newRidge / Math.max(0.05, halfSpan)) * 180) / Math.PI;
    // coalesceKey: EIN First-Drag (viele Maus-Move-Schritte) soll EINEN Undo-
    // Schritt erzeugen, s. `state/projectSlice.ts::updateRoof`-Doc.
    updateRoof(roofId, { pitchDeg: Math.max(1, Math.min(85, newPitch)) }, `onEdit3dRoofPitch:${roofId}`);
    // Cursor-HUD (First-Höhe) — bislang zeigten Höhen-/Kanten-/First-Griff als
    // einzige 3D-Griffe GAR KEINEN Wert (Nutzer-Wunsch „generell weiter
    // optimieren"). Anker = Dach-Schwerpunkt (`bodyMoveAnchor`, dieselbe
    // Formel wie der Verschiebe-Griff).
    const at = bodyMoveAnchor(project, { roofId });
    if (at) setDraft({ preview: [], vertices: [], snap: null, hud: { at, text: `First: ${apexHeight.toFixed(3)}m` } });
  };
  // Läuft während eines Kanten-Griff-Drags (Decke): sammelt die seit Drag-
  // Beginn angewandte Verschiebung fürs Δ-HUD — analog `bodyDragRef`, aber
  // ohne Lock-Unterstützung (kein Feld-Controller für Kanten, s. PENDENZEN).
  const edgeDragRef = useRef<{ key: string; start: Vec2; raw: Vec2; applied: Vec2; total?: Vec2 } | null>(null);
  const onEdit3dEdge = (ceilingId: string, aIndex: number, bIndex: number, delta: Vec2) => {
    const key = `${ceilingId}:${aIndex}:${bIndex}`;
    if (!edgeDragRef.current || edgeDragRef.current.key !== key) {
      const c0 = (project.ceilings ?? []).find((x) => x.id === ceilingId);
      const a0 = c0?.outline[aIndex] ?? { x: 0, y: 0 };
      edgeDragRef.current = { key, start: { x: a0.x, y: a0.y }, raw: { x: 0, y: 0 }, applied: { x: 0, y: 0 } };
    }
    const st = edgeDragRef.current;
    st.raw = { x: st.raw.x + delta.x, y: st.raw.y + delta.y };
    // Der Kanten-Startpunkt rastet auf andere Wand-/Zeichnungspunkte ein; die Kante
    // folgt um dasselbe Delta (inkrementell, damit der Store-Aufruf gleich bleibt).
    const rawPoint: Vec2 = { x: st.start.x + st.raw.x, y: st.start.y + st.raw.y };
    const edgeSnap = snapFor3dVertex(rawPoint, new Set(), new Set());
    const snapped = edgeSnap?.point ?? rawPoint;
    const total: Vec2 = { x: snapped.x - st.start.x, y: snapped.y - st.start.y };
    const step: Vec2 = { x: total.x - st.applied.x, y: total.y - st.applied.y };
    if (step.x !== 0 || step.y !== 0) moveCeilingEdge(ceilingId, aIndex, bIndex, step);
    st.applied = total;
    st.total = total;
    const c = (project.ceilings ?? []).find((x) => x.id === ceilingId);
    const a = c?.outline[aIndex];
    const b = c?.outline[bIndex];
    if (a && b) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.hypot(st.total.x, st.total.y);
      setDraft({ preview: [], vertices: [], snap: edgeSnap, hud: { at: mid, text: `Δ: ${dist.toFixed(3)}m` } });
    }
  };
  const onEdit3dWallTop = (wallId: string, topZ: number) => {
    // coalesceKey: EIN Höhen-Drag soll EINEN Undo-Schritt erzeugen, s.
    // `state/projectSlice.ts::updateWall`-Doc.
    updateWall(wallId, { top: { mode: "custom", z: topZ } }, `onEdit3dWallTop:${wallId}`);
    const at = bodyMoveAnchor(project, { wallId });
    if (at) setDraft({ preview: [], vertices: [], snap: null, hud: { at, text: `OK: ${topZ.toFixed(3)}m` } });
  };
  const onEdit3dEnd = () => {
    bodyDragRef.current = null;
    edgeDragRef.current = null;
    last3dDragRef.current = null;
    setGrip3dEdit(null);
    setDraft(null);
  };

  // ── Selektions-Attribut-Kontrakt (Attributes-/Object-Info-Paletten) ───────
  // Normalisierte, effektiv aufgelöste Sicht auf das erste selektierte Element.
  // Eine gewählte Layout-Annotation hat Vorrang (eigener, minimaler Zweig —
  // sie ist kein Projekt-Bauteil, `deriveSelection` kennt sie nicht): Farbe
  // (Linie/Rechteck/Text) + Strichstärke (nur Linie/Rechteck, s. `annotKind`-
  // Prüfung in AttributesPanel) landen so in DERSELBEN Palette wie ein
  // Drawing2D im Grundriss (Nutzer-Feedback).
  const selection = useMemo((): Selection | null => {
    if (selectedLayoutAnnotation) {
      const a = selectedLayoutAnnotation;
      return {
        kind: "layoutAnnotation",
        annotKind: a.kind,
        id: a.id,
        categoryCode: "",
        color: ("color" in a ? a.color : undefined) ?? "#111111",
        weightMm: ("weightMm" in a ? a.weightMm : undefined) ?? 0.25,
        isImage: a.kind === "image",
        opacity: a.kind === "image" ? a.opacity ?? 1 : undefined,
        bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      };
    }
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
      selectedLayoutAnnotation,
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
      onExportStep,
      onImportStep: () => stepInputRef.current?.click(),
      onImportIfc: () => ifcInputRef.current?.click(),
      onClashCheck: () => {
        const p0 = project;
        runClashCheck(p0)
          .then((clashes) => {
            setProject((p) => applyClashMarkers(p, clashes, activeCategoryCode));
            // window.alert ist im Tauri-WKWebView wirkungslos → Toast.
            notify(
              clashes.length === 0
                ? t("clash.none")
                : `${t("clash.found")}: ${clashes.length} — ` +
                    clashes
                      .slice(0, 5)
                      .map((c, k) => `K${k + 1} ${c.a.kind}↔${c.b.kind}${c.volume !== null ? ` ${c.volume.toFixed(3)} m³` : ""}`)
                      .join(", "),
              clashes.length === 0 ? "info" : "warning",
            );
          })
          .catch((err) => notify(`${t("clash.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error"));
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
      onMove: () => startTransformOp("move"),
      onMirror: () => startTransformOp("mirror"),
      onRotate: () => startTransformOp("rotate"),
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

  // Handler-Bündel für das schwebende Ressourcen-Fenster (ResourceManager).
  const resourceHandlers: ResourceManagerHandlers = {
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

  // ── Layout-Blatt (DOSSIER A3, Phase 2b): das offene Blatt + Viewport-Handler ─
  // Das offene Layout wird live aus dem Projekt gelesen (Single Source of Truth);
  // wurde es zwischenzeitlich gelöscht, ist es undefined → der Haupt-Viewport
  // zeigt wieder die Modell-Ansicht. Die Handler mutieren immutabel über die
  // pure CRUD-Ebene (panels/layoutModel.ts).
  const activeLayout =
    activeLayoutId !== null
      ? (project.layouts ?? []).find((l) => l.id === activeLayoutId)
      : undefined;
  const patchOpenLayout = (id: string, fn: (l: Layout) => Layout, coalesceKey?: string) =>
    setProject(
      (p) => ({
        ...p,
        layouts: (p.layouts ?? []).map((l) => (l.id === id ? fn(l) : l)),
      }),
      coalesceKey,
    );

  // ── Effektive Darstellung für die Hauptansicht ────────────────────────────
  // 3D: Geschosse nach dem Modus des Zeichnungsebenen-Panels, Kategorien nach
  // dem Modus des Ebenen-Panels. Grundriss: Kategorien nach dem Ebenen-Panel.
  // Aus der abonnierten Map lesen (nicht über modeFor), damit ein Moduswechsel
  // garantiert ein Re-Render auslöst und die Resolver neu rechnen.
  const drawingLevelsMode =
    displayModes[BUILTIN_PANEL_IDS.drawingLevels] ?? "all";
  const layersMode = displayModes[BUILTIN_PANEL_IDS.layers] ?? "all";

  // Sichtbarkeit je Kategorie-Code (für categoryDisplay), Baum berücksichtigt.
  const codeVisible = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const c of flattenCategories(project.layers)) map.set(c.code, c.visible);
    return map;
  }, [project.layers]);

  // Resolver: je Geschoss-ID die Render-Entscheidung (aktiv = Arbeitsfokus).
  // Memoisiert, damit Plan/3D nicht bei jedem Render neu rechnen.
  const floorDisplay: CategoryDisplayResolver & DisplayResolver = useMemo(() => {
    const visible = new Map(
      project.drawingLevels.map((z) => [z.id, z.visible]),
    );
    return (id) =>
      itemDisplay(drawingLevelsMode, id === activeLevelId, visible.get(id) ?? false);
  }, [project.drawingLevels, drawingLevelsMode, activeLevelId]);

  // Resolver: je Kategorie-Code die Render-Entscheidung. „Aktiv" = die per
  // Klick im Ebenen-Panel gewählte Kategorie (activeCategoryCode, wie schon
  // in LayersPanel.tsx für die Zeilen-Hervorhebung genutzt). Wirkt in
  // Grundriss UND 3D.
  const categoryDisplay: CategoryDisplayResolver & DisplayResolver = useMemo(
    () => (code) =>
      itemDisplay(layersMode, code === activeCategoryCode, codeVisible.get(code) ?? false),
    [layersMode, codeVisible, activeCategoryCode],
  );

  // Stabiler Schlüssel der 3D-Display-Entscheidungen (Resolver sind nicht
  // referenzstabil → triggert sonst keinen Neuaufbau).
  const displayKey = `${drawingLevelsMode}|${layersMode}|${activeLevelId}|${activeCategoryCode}`;

  // ── Ableitungen für Oberleiste + Status-Leiste ────────────────────────────
  // Eine zoom-/cursor-fähige Plan-Ansicht ist nur im Grundriss eines Geschosses
  // aktiv. Sonst sind Cursor/Zoom bedeutungslos (PlanView ist nicht montiert →
  // das Handle ist null, Aktionen sind No-Ops).
  const planActive = activeLevel.kind === "floor" && viewType === "grundriss";
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

  // Hell/Dunkel (Einstellungen → Darstellung). Standard Hell (styles.css);
  // Dunkel ist Opt-in und persistiert in localStorage.
  const { themeMode, setThemeMode } = useThemeModeState();

  // Einstellungen als eigenes natives Fenster (Tauri) statt Overlay-Dialog —
  // hält es (falls offen) synchron zu den betroffenen Feldern, wendet dessen
  // Befehle auf die echten Setter an (siehe native/settingsWindow.ts).
  const setScaleLineWeights = (on: boolean) =>
    setProject((p) => {
      const { scaleLineWeights: _old, ...rest } = p;
      return on ? { ...rest, scaleLineWeights: true } : rest;
    });
  useSettingsWindowHost(
    {
      themeMode,
      marqueeColor,
      snapColor,
      referenceElevationMasl: project.referenceElevationMasl,
      scaleLineWeights: project.scaleLineWeights === true,
      offline,
      layout,
    },
    {
      onThemeModeChange: setThemeMode,
      onMarqueeColorChange: setMarqueeColor,
      onSnapColorChange: setSnapColor,
      onReferenceElevationChange: (n) =>
        setProject((p) => ({ ...p, referenceElevationMasl: n })),
      onScaleLineWeightsChange: setScaleLineWeights,
      onOfflineChange,
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
    onSetGeoAnchor: (anchor) => setProject((p) => ({ ...p, geoAnchor: anchor })),
  });

  // Zeichnungsebenen-Manager als eigenes natives Fenster (DOSSIER-Rhino-
  // Referenz) — additiv NEBEN dem bestehenden Dock-Panel, siehe
  // native/drawingLevelsWindow.ts Kopfkommentar (Rechtsklick-Kontextmenü
  // bewusst nicht mitgenommen).
  useDrawingLevelsWindowHost(
    {
      drawingLevels: project.drawingLevels,
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
    activeTool !== "select" || !!activeTransform || commandActive;

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

  // Modusleiste-Wechsel: array/distribute fragen die Kopienanzahl ab.
  const onTransformMode = (mode: CopyMode) => {
    if (mode === "array" || mode === "distribute") {
      requestCopyCount(mode);
    } else {
      setActiveTransform((tr) => (tr ? { ...tr, copyMode: mode } : tr));
    }
  };

  // ── Transformation in der Befehlszeile ────────────────────────────────────
  // Die laufende Transformation speist Prompt + U/I/O/P-Optionen + ein Live-Feld
  // (Winkel beim Drehen, Distanz beim Bewegen) in die Command-Line — statt einer
  // eigenen schwebenden Leiste. Rein die UI-Fläche; Geometrie unverändert.
  const TRANSFORM_MODES: { id: CopyMode; labelKey: string; key: string }[] = [
    { id: "move", labelKey: "transform.mode.move", key: "U" },
    { id: "copy", labelKey: "transform.mode.copy", key: "I" },
    { id: "array", labelKey: "transform.mode.array", key: "O" },
    { id: "distribute", labelKey: "transform.mode.distribute", key: "P" },
  ];

  const transformOptions = (): CommandLineOption[] => {
    const tr = activeTransform;
    if (!tr) return [];
    return TRANSFORM_MODES.map((m) => ({
      id: m.id,
      labelKey: m.labelKey,
      key: m.key,
      active: tr.copyMode === m.id,
      // ×count nur beim aktiven Reihen-/Verteilungs-Modus.
      value:
        (m.id === "array" || m.id === "distribute") && tr.copyMode === m.id
          ? `×${tr.count}`
          : undefined,
    }));
  };

  // Live-/lockbares Feld: Winkel (Drehen, ab Zentrum+Bezug) bzw. Distanz
  // (Bewegen, ab Basispunkt). Ohne Bezugspunkt kein sinnvolles Feld → [].
  const transformFields = (): CommandLineField[] => {
    const tr = activeTransform;
    const info = transformDragInfoRef.current;
    if (!tr || !info) return [];
    const cursor = info.cursor;
    if (tr.op === "rotate") {
      if (tr.points.length !== 2) return [];
      const c = tr.points[0], refP = tr.points[1];
      const a0 = Math.atan2(refP.y - c.y, refP.x - c.x);
      const a1 = Math.atan2(cursor.y - c.y, cursor.x - c.x);
      const deg = ((((a1 - a0) * 180) / Math.PI) % 360 + 360) % 360;
      return [
        { id: "angle", labelKey: "cmd.field.angle", value: deg, locked: false, active: true },
      ];
    }
    // Bewegen: Distanz ab Basispunkt. Spiegeln hat kein sinnvolles Zahlenfeld
    // (freie Achse) → keine Felder.
    if (tr.op !== "move") return [];
    if (tr.points.length !== 1) return [];
    const base = tr.points[0];
    const dist = Math.hypot(cursor.x - base.x, cursor.y - base.y);
    return [
      { id: "distance", labelKey: "cmd.field.distance", value: dist, locked: false, active: true },
    ];
  };

  // Feld-Zustand fürs Cursor-HUD (neben der Maus, VW-Stil): läuft ein Punkt-
  // ODER Kanten-Griff-Drag, hat er Vorrang (dieselben Felder wie unten in der
  // Befehlszeile — Länge/Winkel- bzw. Abstand-Tab-Zyklus), dann eine laufende
  // Transformation (m/s/d — Winkel beim Drehen bzw. Distanz beim Bewegen,
  // Nutzer-Wunsch „bei Drehen auch eine Darstellung"), sonst die Befehls-
  // Engine-Felder beim Zeichnen. Vorher zeigte das Cursor-HUD beim Griff-Ziehen
  // GAR KEINE Länge/Winkel-Werte an (nur die Befehlszeile unten) — Nutzer-
  // Wunsch: „du kannst [Länge/Winkel] gleich bei der Maus anzeigen wie beim
  // Erstellen". Nach `transformFields` platziert (nicht weiter oben), weil es
  // deren Deklaration direkt aufruft (keine Ref/Closure-Indirektion nötig).
  const activeTransformFields = activeTransform ? transformFields() : [];
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
          : activeTransformFields.length > 0
          ? { fields: activeTransformFields, typed: cmdTyped }
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

  // Getippte Zahl in der Transformation: als Wert des aktiven Feldes deuten und
  // über denselben Pfad wie transformClick committen.
  const submitTransformValue = (value: number) => {
    const tr = activeTransform;
    const info = transformDragInfoRef.current;
    if (!tr || !info) return;
    if (tr.op === "rotate") {
      if (tr.points.length !== 2) return;
      const c = tr.points[0], refP = tr.points[1];
      const a0 = Math.atan2(refP.y - c.y, refP.x - c.x);
      const a = a0 + (value * Math.PI) / 180;
      const r = Math.hypot(refP.x - c.x, refP.y - c.y) || 1;
      const target = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
      const points = [...tr.points, target];
      commitTransformOn(transformSel, tr.op, points, tr.copyMode, tr.count);
    } else if (tr.op === "move") {
      if (tr.points.length !== 1) return;
      // Distanz entlang der aktuellen Live-Richtung locken.
      const base = tr.points[0];
      const dx = info.cursor.x - base.x, dy = info.cursor.y - base.y;
      const len = Math.hypot(dx, dy) || 1;
      const target = { x: base.x + (dx / len) * value, y: base.y + (dy / len) * value };
      const points = [...tr.points, target];
      commitTransformOn(transformSel, tr.op, points, tr.copyMode, tr.count);
    }
    setActiveTransform(null);
    setDraft(null);
    transformDragInfoRef.current = null;
  };

  const cancelTransform = () => {
    setActiveTransform(null);
    setDraft(null);
    transformDragInfoRef.current = null;
  };


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
    project,
    activeLevelId: activeLevel.id,
    activeCategoryCode,
    setProject,
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
  );

  // Host-Context für die Panels — siehe state/usePanelHostBase.ts.
  const baseHost = usePanelHostBase({
    project,
    setProject,
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
    activeLayout,
    patchOpenLayout,
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
        accept=".dxf,.dwg,.ifc,text/plain"
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
            .then((text) => stepTextToImportedMeshes(text, f.name))
            .then((objs) => addContextObjectsAndFit(objs))
            .catch((err) =>
              notify(`${t("step.import.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error"),
            );
        }}
      />
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
      <TopBar
        project={project}
        zoomEnabled={planActive}
        onExportPdf={() => setExportOpen(true)}
        onExportDxf={() => setExportDxfOpen(true)}
        onExportSchedule={onExportSchedule}
        onExportIfc={onExportIfc}
        onExportObj={onExportObj}
        onExportStl={onExportStl}
        onExportStep={onExportStep}
        viewType={viewType}
        fov={fov}
        onFov={setFov}
        cameraEnabled={activeLevel.kind === "floor"}
        resourcesOpen={resourcesOpen}
        onToggleResources={() => toggleResources()}
        onOpenSettings={() => openSettings()}
        onImport={() => dxfInputRef.current?.click()}
        onSaveProject={onSaveProject}
        onOpenProject={onOpenProject}
        // Unter Tauri (macOS) übernimmt die native Systemmenüleiste (oben am
        // Bildschirm, useNativeAppMenu) exakt dieselben Aktionen bereits —
        // die In-App-Menüleiste wäre reine Dopplung und kostet nur Platz in
        // der Kopfzeile. Im Browser/Electron (kein natives App-Menü) bleibt
        // sie die einzige Quelle dafür.
        menuBar={
          isTauriRuntime() ? undefined : (
            <AppMenuBar
              onNewProject={onNewProject}
              onNewProjectFromSample={onNewProjectFromSample}
              onNewProjectFromTemplate={onNewProjectFromTemplate}
              onOpenProject={onOpenProject}
              onSaveProject={onSaveProject}
              onImport={() => dxfInputRef.current?.click()}
              onUndo={undo}
              onRedo={redo}
              canUndo={canUndo}
              canRedo={canRedo}
              onDeleteSelection={deleteSelection}
              hasSelection={hasSelectionToDelete()}
              viewType={viewType}
              onViewType={setViewType}
              view3d={view3d}
              onView3d={setView3d}
              referenceLines={referenceLines}
              onReferenceLines={setReferenceLines}
              resourcesOpen={resourcesOpen}
              onToggleResources={() => toggleResources()}
              onOpenSettings={() => openSettings()}
            />
          )
        }
        viewControls={
          <ViewRibbonTab
            viewToggleEnabled={activeLevel.kind === "floor"}
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
            onApplyScale={applyScale}
            liveScale={planActive ? liveScale : null}
            zoomPercent={zoomPercent}
            zoomEnabled={planActive}
            onFit={fitPlan}
            onFitSelection={fitSelection}
            onZoom100={zoomToApplied}
            renderMode={renderMode}
            onRenderMode={setRenderMode}
            renderModeEnabled={viewType === "perspektive"}
            planColorMode={planColorMode}
            onPlanColorMode={setPlanColorMode}
            shadowsAvailable={activeLevel.kind === "elevation"}
            shadows={activeLevel.shadows ?? false}
            onShadows={(v) =>
              setProject((p) => ({
                ...p,
                drawingLevels: p.drawingLevels.map((z) =>
                  z.id === activeLevel.id ? { ...z, shadows: v } : z,
                ),
              }))
            }
            combos={{
              // Ebenen-Kombinationen: Speichern = Snapshot des Layer-Baums →
              // localStorage; Laden = Map lesen → Sichtbarkeits-Flags anwenden.
              listLayerCombos,
              saveLayerCombo: (name) =>
                saveLayerCombo(name, snapshotLayerVisibility()),
              loadLayerCombo: (name) => {
                const codes = loadLayerCombo(name);
                if (codes) applyLayerVisibility(codes);
              },
              deleteLayerCombo,
              // Zeichnungs-Kombinationen: analog über drawingLevels[].visible.
              listDrawingCombos,
              saveDrawingCombo: (name) =>
                saveDrawingCombo(name, snapshotDrawingVisibility()),
              loadDrawingCombo: (name) => {
                const ids = loadDrawingCombo(name);
                if (ids) applyDrawingVisibility(ids);
              },
              deleteDrawingCombo,
            }}
            textTarget={textTarget}
            textStyles={project.textStyles ?? DEFAULT_PRESETS}
          />
        }
      />

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
        {activeLayout ? (
          /* Layout-Modus (Phase 2b): das Blatt füllt den Haupt-Viewport (statt
             Grundriss/3D) und ist direkt mit der Maus editierbar — platzieren/
             verschieben/skalieren/löschen der Viewports, Pan/Zoom, mm↔Bildschirm.
             Die Befehlszeile entfällt (kein Zeichnen auf dem Blatt). */
          <LayoutSheetView
            project={project}
            layout={activeLayout}
            activeTool={activeTool}
            onToolChange={onSelectTool}
            selectedAnnotId={selectedLayoutAnnotationId}
            onSelectAnnot={setSelectedLayoutAnnotationId}
            handlers={{
              onBack: () => {
                setActiveLayoutId(null);
                setSelectedLayoutAnnotationId(null);
                // Ein auf dem Blatt armiertes Zeichenwerkzeug (line/rect/text/
                // image) hat im Grundriss KEINEN laufenden Befehl in der Engine
                // (der wird für ein offenes Layout bewusst nicht gestartet, s.
                // `onSelectTool`) — zurück auf „Auswahl", sonst zeigt das
                // Werkzeugpanel ein „aktives" Werkzeug ohne echten Befehl dahinter.
                setActiveTool("select");
              },
              onPatchViewport: (viewportId, patch) =>
                patchOpenLayout(activeLayout.id, (l) =>
                  patchViewportInLayout(l, viewportId, patch),
                ),
              onRemoveViewport: (viewportId) =>
                patchOpenLayout(activeLayout.id, (l) =>
                  removeViewportFromLayout(l, viewportId),
                ),
              onAddViewport: (snapshotId, init) =>
                patchOpenLayout(activeLayout.id, (l) =>
                  addViewportToLayout(
                    l,
                    createViewport(`vp-${Date.now()}`, snapshotId, init),
                  ),
                ),
              onAddAnnotation: (kind, init) => {
                const id = `ann-${Date.now()}`;
                patchOpenLayout(activeLayout.id, (l) =>
                  addAnnotationToLayout(l, createAnnotation(id, kind, init)),
                );
                return id;
              },
              onPatchAnnotation: (annotationId, patch, coalesceKey) =>
                patchOpenLayout(
                  activeLayout.id,
                  (l) => patchAnnotationInLayout(l, annotationId, patch),
                  coalesceKey,
                ),
              onRemoveAnnotation: (annotationId) =>
                patchOpenLayout(activeLayout.id, (l) =>
                  removeAnnotationFromLayout(l, annotationId),
                ),
            }}
          />
        ) : (
        <>
        {/* Hauptansicht (Mitte) — füllt den verbleibenden Platz. Die Plan-
            Ansicht meldet Cursor + Zoom an die Status-/Oberleiste und nimmt
            das Zoom-Handle entgegen. */}
        <Content
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
          onToggleGrid3d={() => setGrid3dVisible(!grid3dVisible)}
          section3d={section3dPlane}
          onClearSection3d={() => setSection3dCutId(null)}
          mono={planColorMode === "mono"}
          viewSnapshotTabs={{
            selectedId: baseHost.selectedViewSnapshotId,
            onApply: baseHost.onApplyViewSnapshot,
            onCaptureAuto: baseHost.onCaptureViewSnapshotAuto,
            onDelete: baseHost.onDeleteViewSnapshot,
          }}
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
          onStampMove={moveRoomStamp}
          onStampEdit={onOpenStampEditor}
          onEditDrawingText={onEditDrawingText}
          onEnterGroup={onEnterGroup}
          onLeaveGroup={onLeaveGroup}
          groupPath={groupPath}
          editTextId={editTextId}
          editTextMinHeightM={editTextMinHeightM}
          onCommitTextEdit={commitTextEdit}
          onCloseTextEdit={closeTextEdit}
          onPlanSelect={onPlanSelect}
          onPlanMarquee={onPlanMarquee}
          onSegmentCut={onSegmentCut}
          onPlanContextMenu={onPlanContextMenu}
          onViewport3dPick={onViewport3dPick}
          // Zeichnen-Modus des 3D-Viewports gilt AUCH während einer
          // interaktiven Transformation (m/s/d) — sonst würde ein Klick im 3D
          // während des Drehens/Verschiebens/Spiegelns weiterhin als Orbit/
          // Auswahl interpretiert statt als Transformations-Punkt (s.
          // `onWorkplanePoint`-Doc oben).
          commandActive={commandActive || !!activeTransform}
          draft={draft}
          onWorkplanePoint={onWorkplanePoint}
          onWorkplaneConfirm={onWorkplaneConfirm}
          activeTool={activeTool}
          toolInputActive={toolInputActive}
          toolHandlers={toolHandlers}
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
          onGrip3dEditTab={cycleGrip3dEditField}
          onGrip3dEditCancel={cancelGrip3dEdit}
        />
        {/* Command-Line (Rhino-artig) UNTER dem Viewport — nur Viewport-breit.
            Prompt + klickbare Inline-Optionen + Texteingabe + Autocomplete. */}
        <CommandLine
          ref={commandLineRef}
          // (c) Während eines Vertex- ODER Kanten-Griff-Drags belegt der Feld-
          // Controller das Befehlsfeld (Länge/Winkel bzw. Abstand). Läuft eine
          // Auswahl-Transformation (Drehen etc.), belegt sie Prompt + U/I/O/P +
          // Winkel-/Distanzfeld. Sonst gilt die Engine (Zeichnen/Ruhe). Griff-/
          // Kanten-Drag haben Vorrang (schließen sich sonst aus).
          active={
            gripEdit
              ? true
              : edgeEdit
              ? true
              : grip3dEdit
              ? true
              : activeTransform
              ? true
              : engineView.active
          }
          promptKey={
            gripEdit
              ? "cmd.edit.point"
              : edgeEdit
              ? "cmd.edit.edge"
              : grip3dEdit
              ? "cmd.edit.point"
              : activeTransform
              ? `transform.hint.${activeTransform.op}.${Math.min(
                  activeTransform.points.length,
                  activeTransform.op === "rotate" ? 2 : 1,
                )}`
              : engineView.promptKey
          }
          options={
            gripEdit || edgeEdit || grip3dEdit
              ? []
              : activeTransform
              ? transformOptions()
              : engineView.options
          }
          fields={
            gripEdit
              ? gripEditFields()
              : edgeEdit
              ? edgeEditFields()
              : grip3dEdit
              ? grip3dEditFields(grip3dEdit, last3dDragRef.current?.raw ?? grip3dEdit.anchor)
              : activeTransform
              ? transformFields()
              : engineView.fields
          }
          onSubmit={(text) => {
            if (gripEdit) {
              const v = parseFloat(text.replace(",", "."));
              if (isFinite(v)) submitGripEditValue(v);
              // Leere Eingabe: kein neuer Wert zu locken — Enter bestätigt
              // stattdessen die aktuelle Position (Maus- oder bereits
              // gelockte Werte) und schließt die Griff-Bearbeitung ab. Vorher
              // ein Totdruck (Nutzer-Report: Enter tat nichts).
              else planViewRef.current?.confirmGripEdit();
              return;
            }
            if (edgeEdit) {
              const v = parseFloat(text.replace(",", "."));
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
            if (activeTransform) {
              const v = parseFloat(text.replace(",", "."));
              if (isFinite(v)) submitTransformValue(v);
              return;
            }
            // Getipptes „rotate"/„drehen" startet die interaktive Drehung (U/I/O/P),
            // analog zum Ribbon-Button und der Taste „d".
            const cmdWord = text.trim().toLowerCase();
            if (cmdWord === "rotate" || cmdWord === "drehen") {
              startTransformOp("rotate");
              return;
            }
            engine.submitText(text);
          }}
          onOption={(id) =>
            activeTransform ? onTransformMode(id as CopyMode) : engine.chooseOption(id)
          }
          onCycleField={() =>
            gripEdit
              ? cycleGripEditField()
              : edgeEdit
              ? cycleEdgeEditField()
              : grip3dEdit
              ? cycleGrip3dEditField()
              : activeTransform
              ? undefined
              : engine.cycleField()
          }
          onCancel={() =>
            gripEdit
              ? closeGripEditField()
              : edgeEdit
              ? closeEdgeEditField()
              : grip3dEdit
              ? setGrip3dEdit(null)
              : activeTransform
              ? cancelTransform()
              : engine.cancel()
          }
          suggest={(prefix) => engine.suggest(prefix)}
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
          <PanelHostContext.Provider
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
          </PanelHostContext.Provider>
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
        lineModeEnabled={activeLevel.kind !== "floor" || viewType === "grundriss"}
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

      {/* Modaler Import-Dialog (DXF/DWG) — offen, sobald eine Datei gewählt/
          fallengelassen wurde. Liefert eine strukturierte Entscheidung an
          runImport (Ebene anlegen / Drawings anhängen / Meshes als Kontext). */}
      {importState && (
        <ImportDialog
          fileName={importState.fileName}
          isDwg={importState.isDwg}
          loading={importState.loading ?? false}
          progress={importState.progress}
          parsed={importState.parsed}
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
          onReferenceElevationChange={(n) =>
            setProject((p) => ({ ...p, referenceElevationMasl: n }))
          }
          scaleLineWeights={project.scaleLineWeights === true}
          onScaleLineWeightsChange={setScaleLineWeights}
          offline={offline}
          onOfflineChange={onOfflineChange}
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
          onSave={(fmt, filename) => {
            runExport(fmt, filename);
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
          onConfirm={commitCopyCount}
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
