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
//
// App.tsx selbst ist nur noch die Verdrahtung ([121], [163]): Store-Zustand lesen, die Hooks unter
// src/state/ in fester Reihenfolge aufrufen (Befehls-Engine, Griffe, Auswahl-Befehle, Datei-Aktionen,
// Einstellungen, native Fenster und Menü …) und das Gerüst rendern (Kopfzeile, Docks um die Mitte,
// Status-Leiste, Dialoge). Wer was übernimmt: src/state/README.md und doc/ARCHITEKTUR.md.
//
// [121] App abonniert das Projekt NICHT: nur schmale Ausschnitte (Zeichnungsebenen, Ebenen-Baum, Name,
// Textstile …), die sich bei einer Op an Bauteilen nicht ändern. Was das ganze Projekt liest, liegt in
// den Komponenten, die es brauchen: Griffe und Befehlszeile in `ViewportCenter`, das Kontextmenü in
// `AppContextMenu`, Dialoge in `AppDialogs`, Abgleiche ohne Anzeige in `ProjectSync`; Handler lesen
// das Projekt beim Aufruf aus dem Store (`getState()`).

import { useEffect, useMemo, useRef, type ComponentProps } from "react";
import { patchItem } from "./core";
import { collectVisibleCodes } from "./model/types";
import { isSheetLevel, effectiveSheetSizeMm, findMaster, sheetMmToModel, SHEET_SCALE_DENOMINATOR } from "./model/layoutModel";
import { setDxfImportTrigger } from "./io/dxfImportHook";
import { DEFAULT_PRESETS } from "./text/richText";
import { unitsForLevel } from "./tools/displayUnits";
import type { ToolHandlers } from "./tools/types";
import { checkForUpdate } from "./update/checkForUpdate";
import { useT } from "./i18n";

// Globaler Store (Slices: project/selection/view/layout) und lokaler UI-Zustand.
import { useStore } from "./state/appStore";
import { setCursor } from "./state/cursorStore";
import { setLiveScale } from "./state/liveScaleStore";
import { openMeshFileDialog, requestMeshImport, splitMeshFiles } from "./state/meshImportStore";
import { openPointCloudFileDialog } from "./state/pointCloudStore";
import { clearKinds, toIdLists } from "./state/selection";
import { loadDrawingCombo, loadLayerCombo, saveDrawingCombo, saveLayerCombo } from "./state/visibilitySets";
import { useViewTabs } from "./state/viewTabs";
import { openLevel, switchViewType } from "./state/tabNavigation";
import { useDialogState } from "./state/useDialogState";
import { useTopBarState } from "./state/useTopBarState";
import { useDrawingToolState } from "./state/useDrawingToolState";
import { useSelectionState } from "./state/useSelectionState";
import { useContextMenuState } from "./menus/useContextMenuState";

// Verdrahtung (Hooks aus App.tsx herausgelöst, s. src/state/README.md).
import { useProjectActions } from "./state/useProjectActions";
import { useCommandEngineHost } from "./state/useCommandEngineHost";
import { TRANSFORM_COMMANDS, useToolInput } from "./state/useToolInput";
import { useSelectionCommands } from "./state/useSelectionCommands";
import {
  useActiveToolKeys,
  useElementClipboardShortcut,
  useUndoRedoShortcut,
} from "./state/useKeyboardShortcuts";
import { useProjectFileActions } from "./state/useProjectFileActions";
import { useModelImport } from "./state/useModelImport";
import { useTextTarget } from "./state/useTextTarget";
import { useSectionLineState } from "./state/useSectionLineState";
import { useDockDragState } from "./state/useDockDragState";
import { useResourceHandlers } from "./state/useResourceHandlers";
import { selectModelView } from "./state/useModelViewHandlers";
import { useSheetPane } from "./state/useSheetPane";
import { useDisplayResolvers } from "./state/useDisplayResolvers";
import { useSettingsHost } from "./state/useSettingsHost";
import { useNativeWindowHosts } from "./state/useNativeWindowHosts";
import { useNativeMenu } from "./state/useNativeMenu";
import { useStatusBarInfo } from "./state/useStatusBarInfo";
import { useExportHandlers } from "./state/useExportHandlers";
import { useMouseSelectionHandlers } from "./state/useMouseSelectionHandlers";
import { useFileDropImport, useImageImportHandling } from "./state/useImportHandling";
import { usePanelHostBase } from "./state/usePanelHostBase";
import { useEventBundle } from "./state/useEvent";

// Oberfläche.
import type { PlanViewHandle } from "./views/plan/PlanView";
import type { Content } from "./views/viewportContent";
import { ViewportCenter } from "./views/ViewportCenter";
import { revealPanel, saveLayout } from "./panels/layout";
import { DockArea } from "./panels/DockArea";
// Seiteneffekt: registriert die zwei dockbaren Kern-Panels in der Registry.
import "./panels/builtinPanels";
import { AppContextMenu } from "./menus/AppContextMenu";
import { LayerInlineEditor, LevelInlineEditor } from "./menus/InlineEditors";
import { AppDialogs } from "./ui/AppDialogs";
import { BootScreen, useBootPhase } from "./ui/BootScreen";
import { HiddenFileInputs } from "./ui/HiddenFileInputs";
import { ProjectSync } from "./ui/ProjectSync";
import { StatusBar } from "./ui/StatusBar";
import { Toast } from "./ui/Toast";
import { TopBar } from "./ui/TopBar";
import { useTopBarElements } from "./ui/useTopBarElements";

export default function App() {
  // Sprachwechsel abonnieren: re-rendert den gesamten Baum, wenn die Sprache
  // umgeschaltet wird (alle Kinder lesen denselben modulweiten Zustand über t).
  useT();

  // ── Boot-Sequenz: Splash → Startbildschirm → Editor (Fenstergrösse je Phase) → ui/BootScreen.tsx ──
  const [bootPhase, setBootPhase] = useBootPhase();

  // ── Globaler Zustand aus dem Store (Slices: project/selection/view/layout) ─
  // Pro useStore-Aufruf EIN Feld selektieren (Referenz-Gleichheit, sonst
  // Endlosschleife). Actions leben ebenfalls im Zustand und sind referenzstabil.
  // Vom Projekt nur schmale Ausschnitte ([121]): eine Op an Bauteilen ändert keinen davon.
  const drawingLevels = useStore((s) => s.project.drawingLevels);
  const projectLayers = useStore((s) => s.project.layers);
  const projectName = useStore((s) => s.project.name);
  const textStyles = useStore((s) => s.project.textStyles);
  const modelViewOptions = useStore((s) => s.project.modelViewOptions);
  const masterLayouts = useStore((s) => s.project.masterLayouts);
  const firstWallTypeId = useStore((s) => s.project.wallTypes[0].id);
  const firstLineStyleId = useStore((s) => s.project.lineStyles[0].id);
  const setProject = useStore((s) => s.setProject);
  const applyChange = useStore((s) => s.applyChange);
  const groupChanges = useStore((s) => s.groupChanges);
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
  const dialogs = useDialogState();
  const {
    resourcesOpen, setResourcesOpen, setResourcesTab, setOpeningEditorId, activeLayoutId, setActiveLayoutId,
    setImportState, exportOpen, setExportOpen, setExportDxfOpen, setSettingsOpen, setExportSaveFormat,
    setDropActive,
  } = dialogs;

  // ── Oberleisten-/Status-Zustand (View-State, kein Modell) ─────────────────
  // detail wirkt im Grundriss (Symbole + Schraffuren/Linien), renderMode in der
  // 3D-Ansicht (3 Modi), referenceLines schaltet die Wand-Achslinien.
  const {
    detail, setDetail, renderMode, setRenderMode, view3d, setView3d, fov, setFov, grid3dVisible, setGrid3dVisible,
    planColorMode, setPlanColorMode, referenceLines, setReferenceLines, lineMode, setLineMode, marqueeColor,
    setMarqueeColor, snapColor, setSnapColor, scaleDenominator, setScaleDenominator, selectedViewSnapshotId,
    setSelectedViewSnapshotId,
  } = useTopBarState();

  // ── Zeichenwerkzeuge (transienter View-State; bleibt lokal) ───────────────
  // Aktives Werkzeug, Werkzeug-Parameter (Wandtyp/Kategorie/Linienstil), Snap-
  // Einstellungen sowie der laufende Werkzeug-Zustand (Ref, kein Re-Render je
  // Mausbewegung) und die Live-Vorschau (Draft → Overlay in PlanView).
  const {
    activeTool, setActiveTool, activeWallTypeId, setActiveWallTypeId, activeCategoryCode, setActiveCategoryCode,
    activeLineStyleId, snap, setSnap, draft, setDraft, pendingCopyMode, setPendingCopyMode, requestCopyCount,
    commitCopyCount,
  } = useDrawingToolState(firstWallTypeId, firstLineStyleId);

  // ── Auswahl (Store-Slice, ein `Selection`-Wert, [130]) ──────────────────────
  const {
    selection, setSelection, selectedDrawingId, elementClipboard, setElementClipboard, selectedWallId,
    selectedCeilingId, selectedSectionLineId, section3dCutId, setSection3dCutId, updateRoof, moveRoofGrip,
    moveRoofBy, selectedRoomId, groupPath, setGroupPath,
  } = useSelectionState();

  // ── Kontextmenüs (transienter UI-State, bleibt lokal) ─────────────────────
  const {
    layerClipboard, setLayerClipboard, drawingStyleClipboard, setDrawingStyleClipboard, menu, setMenu, editor,
    setEditor, nativeLayerSettingsCode, setNativeLayerSettingsCode, stampEditorRoomId, setStampEditorRoomId,
    editTextId, setEditTextId, editTextMinHeightM, setEditTextMinHeightM,
  } = useContextMenuState();

  // Beim Geschosswechsel die Wand-Auswahl + offene Overlays zurücksetzen (die
  // Wände eines anderen Geschosses sind eine andere Menge). Der Ansichtswechsel
  // (Grundriss ↔ 3D) lässt die Auswahl bestehen — dieselbe wallId gilt in
  // beiden Ansichten; nur die offenen Overlays werden geschlossen.
  useEffect(() => {
    // Kontext-Objekte (projektweit) und Gruppen bleiben gewählt.
    setSelection((s) => ({ ...clearKinds(), contextObjects: s.contextObjects }));
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
    drawingLevels.find((z) => z.id === activeLevelId) ??
    drawingLevels[0];
  // Massstab der Arbeitsebene: auf einem Blatt Papier 1:1, sonst der gewählte Plan-Massstab.
  const planScale = isSheetLevel(activeLevel) ? SHEET_SCALE_DENOMINATOR : scaleDenominator;
  // Anzeige-Einheiten (Lineale, Statusleiste, HUD, Befehlszeile): auf einem Blatt Papier-mm ([93]).
  const displayUnits = unitsForLevel(activeLevel);

  // Sichtbare Kategorie-Codes — Basisfilter für Grundriss & 3D.
  const visibleCodes = useMemo(
    () => collectVisibleCodes(projectLayers),
    [projectLayers],
  );

  // ── Projekt-Mutationen (aus dem Store-Slice) ─────────────────────────────
  // Sämtliche immutablen Projekt-Mutationen + Ressourcen-Typ-CRUD (Wand-/
  // Decken-/Dach-/Tür-/Fenster-/Treppentyp) in useProjectActions() gebündelt,
  // siehe dort. Früh aufgerufen (nur Store-Selektoren), damit die Hooks unten sie nutzen können.
  const pa = useProjectActions(applyChange, notify, planViewRef);
  const {
    patchCategory, snapshotLayerVisibility, applyLayerVisibility, snapshotDrawingVisibility,
    applyDrawingVisibility, patchLevel, addColorToCustomPalette, fitToContextObjects, updateDrawing2D,
    moveRoomStamp, setRoomStampDoc,
  } = pa;

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

  // ── Command-Engine (Rhino-artiges Befehlssystem) → state/useCommandEngineHost.ts ──
  const selectionState = { selection, groupPath, setSelection };
  const {
    engineRef, engine, engineView, commandActive, commandLineRef, setAliasOverrides, shortcutOverrides,
    setShortcutOverrides, cmdTyped, setCmdTyped,
  } = useCommandEngineHost({
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

  // ── GUI-Werkzeug, Ribbon-Befehl, 3D-Arbeitsebene → Engine (state/useToolInput.ts) ──
  const { toolHandlers, onSelectTool, onRunCommand, onWorkplanePoint, onWorkplaneConfirm } = useToolInput({
    engineRef,
    engine,
    commandLineRef,
    activeTool,
    setActiveTool,
    draft,
    imageInputRef,
  });

  // Globaler Undo/Redo-Shortcut — siehe state/useKeyboardShortcuts.ts.
  useUndoRedoShortcut(undo, redo, shortcutOverrides);

  // Esc/Enter/Backspace für das aktive Zeichenwerkzeug. Siehe
  // state/useKeyboardShortcuts.ts. Die Zifferntasten-Werkzeugwahl
  // (useToolNumberShortcuts) läuft in `ViewportCenter` NACH useGripEditing() — sie
  // braucht dessen gripDragInfoRef, um Zifferntasten während einer Griff-
  // Bearbeitung nicht als Werkzeug-Wechsel misszuverstehen.
  useActiveToolKeys(activeTool, engineRef, setActiveTool);

  // Option der Befehlszeile (Klick, Kürzel): „N Kopien"/„Verteilen" fragen erst die Anzahl ab
  // (Dialog), dann geht die Option mit der Zahl an den laufenden Befehl.
  const onCommandOption = (id: string) => {
    if (id === "array" || id === "distribute") requestCopyCount(id);
    else engine.chooseOption(id);
  };

  // ── Befehle auf der Auswahl + ihre Tastenkürzel → state/useSelectionCommands.ts ──
  const selCmds = useSelectionCommands({
    setProject,
    applyChange,
    groupChanges,
    selection,
    setSelection,
    groupPath,
    setGroupPath,
    patchLevel,
    activeTool,
    activeLevel,
    engine,
    engineView,
    shortcutOverrides,
    drawingStyleClipboard,
    setDrawingStyleClipboard,
    onCommandOption,
    onRunCommand,
  });
  const { hasSelectionToDelete, deleteSelection, selectionLockMembers, selectionLockIds } = selCmds;

  // 2D-/3D-Griffe der Auswahl, Zifferntasten der Werkzeuge und die Befehlszeile: in `ViewportCenter`
  // (lesen das ganze Projekt, [121]).

  const clipboardIds = useMemo(() => toIdLists(selection), [selection]);
  // Ctrl/Cmd+C / Ctrl/Cmd+V = Bauteile kopieren/einfügen (alle 9 Auswahl-Kanäle,
  // nicht nur 2D-Zeichenelemente) — siehe state/useKeyboardShortcuts.ts.
  useElementClipboardShortcut(
    clipboardIds,
    elementClipboard,
    setElementClipboard,
    activeLevelId,
    applyChange,
    setSelection,
    shortcutOverrides,
  );

  // Projektdatei-I/O (Speichern/Öffnen/Lock), Schnellexport (CSV/IFC/OBJ/STL)
  // und die Ausführung eines bestätigten DXF/DWG-Imports — gebündelt in
  // useProjectFileActions(), siehe dort.
  const files = useProjectFileActions(
    setImportState,
    setExportSaveFormat,
    activeCategoryCode,
    setActiveLevelId,
    planViewRef,
  );
  const {
    projectFileInputRef, projectTemplateFileInputRef, openImportForFile, onSaveProject, onSaveProjectAs,
    onNewProject, onNewProjectFromSample, onNewProjectFromComplexSample, onNewProjectFromTemplate,
    onProjectTemplateFileChosen, onExportIfc, onExportObj, onExportStl, onOpenProject, onProjectFileChosen,
  } = files;

  // IFC/STEP/Mesh-Import und Datei-Verteiler (Dialog, Drag & Drop) → state/useModelImport.ts.
  const modelImport = useModelImport({ notify, planViewRef, fitToContextObjects, openImportForFile });
  const { importIfcFile, openImportForAnyFile, importStepFile, onMeshImport } = modelImport;

  // Text-Ziel der Oberleisten-Text-Gruppe (Raumstempel bzw. freier Text) → state/useTextTarget.ts.
  const textTarget = useTextTarget({ selectedRoomId, selectedDrawingId, setRoomStampDoc, updateDrawing2D });

  // ── Gewählte Schnittlinie, 3D-Live-Schnitt → state/useSectionLineState.ts ──
  const { sectionLine, section3dPlane, onToggleSection3dCut } = useSectionLineState({
    activeLevel,
    selectedSectionLineId,
    section3dCutId,
    setSection3dCutId,
  });

  // ── Dock-/Float-Handler (aus dem Layout-Slice) ────────────────────────────
  // Die Layout-Mutationen (Resize/Reorder/Stapeln/Lösen/Float) liegen jetzt im
  // layoutSlice. App liest sie als Store-Actions und verdrahtet sie unverändert
  // mit dem (transienten) Drag-Controller und den Panels.
  const activateTab = useStore((s) => s.activateTab);
  const joinGroup = useStore((s) => s.joinGroup);
  const newGroup = useStore((s) => s.newGroup);
  const dropFloat = useStore((s) => s.dropFloat);
  const dockFloatTo = useStore((s) => s.dockFloatTo);

  // Tab-Drag-Steuerung (Reorder/Einreihen/Stapeln/Lösen) + Float-Titel-Drag
  // über Rand-Andockzonen — siehe state/useDockDragState.ts.
  const dockDrag = useDockDragState({
    layout,
    activateTab,
    joinGroup,
    newGroup,
    dropFloat,
    dockFloatTo,
  });

  // Ressourcen-Fenster: Handler-Bündel, natives Fenster, Öffnen/Umschalten → state/useResourceHandlers.ts.
  const { resourceHandlers, openResources, toggleResources } = useResourceHandlers({
    applyChange,
    groupChanges,
    activeLevel,
    detail,
    setDetail,
    scaleDenominator,
    setScaleDenominator,
    planColorMode,
    setPlanColorMode,
    modeFor,
    setModeFor,
    planViewRef,
    pa,
    setResourcesTab,
    setResourcesOpen,
  });

  // ── Layout-Blatt (DOSSIER A3) → state/useSheetPane.ts ─────────────────────
  const sheetPane = useSheetPane({
    activeLayoutId,
    setActiveLayoutId,
    activeLevelId,
    setActiveLevelId,
    applyChange,
  });

  // ── Effektive Darstellung für die Hauptansicht → state/useDisplayResolvers.ts ──
  const { floorDisplay, categoryDisplay, displayKey, drawingLevelsMode } = useDisplayResolvers({
    activeLevelId,
    activeCategoryCode,
  });

  // ── Ableitungen für Oberleiste + Status-Leiste ────────────────────────────
  // Eine zoom-/cursor-fähige Plan-Ansicht ist nur im Grundriss eines Geschosses
  // aktiv. Sonst sind Cursor/Zoom bedeutungslos (PlanView ist nicht montiert →
  // das Handle ist null, Aktionen sind No-Ops).
  const planActive = activeLevel.kind === "floor" && viewType === "grundriss";
  // 3D gibt es aus Geschoss, Schnitt und Ansicht ([115]); eine freie Zeichnung hat keine Höhe.
  const has3dView = activeLevel.kind !== "drawing" && activeLevel.kind !== "ceiling";
  // Start-Protokoll, Offline, KI-Zugriff, Hell/Dunkel, Einstellungsfenster → state/useSettingsHost.ts.
  const settings = useSettingsHost({
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
  });
  const { openSettings } = settings;

  // Native Nebenfenster (Ebeneneinstellungen, Standort-Import, Zeichnungsebenen) → state/useNativeWindowHosts.ts.
  const { openLayerSettings } = useNativeWindowHosts({
    applyChange,
    activeLevelId,
    setModeFor,
    drawingLevelsMode,
    nativeLayerSettingsCode,
    setNativeLayerSettingsCode,
    setEditor,
    pa,
  });

  // Native macOS-Menüleiste → state/useNativeMenu.ts.
  useNativeMenu({
    files,
    notify,
    undo,
    redo,
    canUndo,
    canRedo,
    setLayout,
    viewType,
    setViewType: switchViewType, // [182] Reiter-Art statt Umbau des Reiters
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
  });
  // Übernimmt ein Zeichenwerkzeug ODER eine laufende Transformation die linke
  // Maustaste der Plan-Ansicht? Dann liegt der Pointer-Input beim Tool/Transform
  // (statt Auswahl/Marquee), und die Editier-Griffe sind ausgeblendet.
  // Ein laufender Befehl übernimmt ebenfalls die linke Maustaste der Plan-Ansicht
  // (über denselben toolHandlers-Pfad) — daher hier mit einbeziehen.
  const toolInputActive =
    activeTool !== "select" || commandActive;

  // Werkzeug-Hinweis und aktive Ebene der Status-Leiste → state/useStatusBarInfo.ts.
  const { toolHint, activeLayerName } = useStatusBarInfo({ selection, activeCategoryCode });

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

  // Plan-Export (PDF/SVG/DXF) samt Inhaltsmass für den Dialog → state/useExportHandlers.ts.
  const planExport = useExportHandlers({
    exportOpen,
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

  // Maus-Schema: Auswahl + Kontextmenü aus Grundriss / 3D — siehe
  // state/useMouseSelectionHandlers.ts.
  const {
    onOpenStampEditor, onEditDrawingText, commitTextEdit, closeTextEdit, onPlanSelect, onPlanMarquee,
    onPlanContextMenu, onViewport3dPick,
  } = useMouseSelectionHandlers({
    setProject,
    activeLevelId: activeLevel.id,
    visibleCodes,
    categoryDisplay,
    floorDisplay,
    selectionState: { selection, setSelection, groupPath },
    contextMenuState: { setMenu, setStampEditorRoomId, editTextId, setEditTextId, setEditTextMinHeightM },
  });

  // „Bild einfügen" (Werkzeug „image") — siehe state/useImportHandling.ts.
  const { onImageOrPdfFileChosen } = useImageImportHandling({
    activeLevelId: activeLevel.id,
    activeCategoryCode,
    // Auf einem Blatt: 60 mm breit, mitten aufs Papier.
    imagePlacement: sheetPane
      ? (() => {
          const m = findMaster({ masterLayouts }, sheetPane.layout);
          const size = effectiveSheetSizeMm(m ?? sheetPane.layout);
          return { widthM: 0.06, center: sheetMmToModel(size.w / 2, size.h / 2) };
        })()
      : undefined,
    applyChange,
    notify,
    setSelection,
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
    projectActions: pa,
    selectionState: { updateRoof, setSelection, selectedSectionLineId, section3dCutId },
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
    onSaveProjectAs,
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
    onSketch: (v: boolean) => applyChange((p) => patchItem(p, "drawingLevels", activeLevel.id, { sketch: v })),
    // [173] Modelldarstellung der aktiven Ansicht (Ebenen-Feld) samt Detailgrad der Anzeige.
    onModelView: (id: string) => selectModelView(applyChange, setDetail, activeLevel.id, id),
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
    cmdStillActive: () => engine.isActive(),
    cmdSuggest: (prefix: string) => engine.suggest(prefix),
    // Hauptansicht (Grundriss/3D).
    onToggleGrid3d: () => setGrid3dVisible(!grid3dVisible),
    onClearSection3d: () => setSection3dCutId(null),
    moveRoomStamp,
    onOpenStampEditor,
    onEditDrawingText,
    onEnterGroup: selCmds.onEnterGroup,
    onLeaveGroup: selCmds.onLeaveGroup,
    commitTextEdit,
    closeTextEdit,
    onPlanSelect,
    onPlanMarquee,
    onSegmentCut: selCmds.onSegmentCut,
    onPlanContextMenu,
    onViewport3dPick,
    onWorkplanePoint,
    onWorkplaneConfirm,
    onToolMove: toolHandlers.onToolMove,
    onToolClick: toolHandlers.onToolClick,
    onToolCommit: toolHandlers.onToolCommit,
    onMeshImport,
    // Versteckte Datei-Felder (memoisiert).
    openImportForAnyFile,
    importStepFile,
    importIfcFile,
    onImageOrPdfFileChosen,
    onProjectFileChosen,
    onProjectTemplateFileChosen,
  });
  const contentToolHandlers: ToolHandlers = useMemo(
    () => ({ onToolMove: ev.onToolMove, onToolClick: ev.onToolClick, onToolCommit: ev.onToolCommit, draft }),
    [ev, draft],
  );
  const viewTabsState = useViewTabs();
  // `autoName` liest die Zeichnungsebenen (Name, Sichtbarkeit): neue Funktion, wenn sie sich ändern,
  // damit die Reiter-Titel nachziehen (die Host-Handler selbst sind stabil, [121]).
  const viewSnapshotTabs = useMemo(
    () => ({
      tabs: viewTabsState,
      onActivate: baseHost.onActivateViewTab,
      onNew: baseHost.onNewViewTab,
      onClose: baseHost.onCloseViewTab,
      autoName: (levelId?: string, is3d?: boolean) => baseHost.viewTabAutoName(levelId, is3d),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseHost, viewTabsState, drawingLevels],
  );
  // In-App-Menüleiste (nur ohne natives Menü) und Ansichts-Ribbon als memoisierte Elemente → ui/useTopBarElements.tsx.
  const { menuBarEl, viewControlsEl } = useTopBarElements({
    ev,
    undo,
    redo,
    canUndo,
    canRedo,
    hasSelection: hasSelectionToDelete(),
    viewType,
    setViewType: switchViewType, // [182] Reiter-Art statt Umbau des Reiters
    view3d,
    setView3d,
    referenceLines,
    setReferenceLines,
    resourcesOpen,
    has3dView,
    planActive,
    detail,
    setDetail,
    scaleDenominator,
    renderMode,
    setRenderMode,
    planColorMode,
    setPlanColorMode,
    activeLevel,
    modelViewOptions,
    textTarget,
    textStyles: textStyles ?? DEFAULT_PRESETS,
  });

  // Props der Hauptansicht, die `App` selbst liefert (der Rest entsteht in `ViewportCenter`).
  const contentProps: Omit<
    ComponentProps<typeof Content>,
    | "project"
    | "roomStamp"
    | "hudFields"
    | "grips"
    | "gripHandleLines"
    | "edgeGrips"
    | "gripHandlers"
    | "edit3dWalls"
    | "edit3dDrawings"
    | "edit3dCeilings"
    | "edit3dRoofs"
    | "onEdit3dVertex"
    | "onEdit3dBody"
    | "onEdit3dEdge"
    | "onEdit3dRoofPitch"
    | "onEdit3dWallTop"
    | "onEdit3dEnd"
    | "onGrip3dEditTab"
    | "onGrip3dEditCancel"
  > = {
    sheet: sheetPane,
    level: activeLevel,
    viewType,
    visibleCodes,
    detail,
    referenceLines,
    scaleDenominator,
    hairline: lineMode === "display",
    showGrid: snap.showGrid,
    marqueeColor,
    snapColor,
    hoverDivideDelayMs: snap.hoverDivideDelayMs,
    hoverDivideCount: snap.hoverDivideCount,
    renderMode,
    view3d,
    fov,
    grid3dVisible,
    onToggleGrid3d: ev.onToggleGrid3d,
    section3d: section3dPlane,
    onClearSection3d: ev.onClearSection3d,
    mono: planColorMode === "mono",
    viewSnapshotTabs,
    onSelectLevel: openLevel,
    floorDisplay,
    categoryDisplay,
    displayKey,
    planViewRef,
    onCursor: setCursor,
    onScale: setLiveScale,
    selection,
    onStampMove: ev.moveRoomStamp,
    onStampEdit: ev.onOpenStampEditor,
    onEditDrawingText: ev.onEditDrawingText,
    onEnterGroup: ev.onEnterGroup,
    onLeaveGroup: ev.onLeaveGroup,
    groupPath,
    editTextId,
    editTextMinHeightM,
    onCommitTextEdit: ev.commitTextEdit,
    onCloseTextEdit: ev.closeTextEdit,
    onPlanSelect: ev.onPlanSelect,
    onPlanMarquee: ev.onPlanMarquee,
    onSegmentCut: ev.onSegmentCut,
    onPlanContextMenu: ev.onPlanContextMenu,
    onViewport3dPick: ev.onViewport3dPick,
    // Zeichnen-Modus des 3D-Viewports (auch Bewegen/Drehen/Spiegeln sind Befehle).
    commandActive,
    draft,
    onWorkplanePoint: ev.onWorkplanePoint,
    onWorkplaneConfirm: ev.onWorkplaneConfirm,
    activeTool,
    toolInputActive,
    toolHandlers: contentToolHandlers,
    onEdit3dGroup: groupChanges,
  };

  // Abgleiche ohne Anzeige (Gauben-Hinweis, natives Ressourcen-Fenster), an derselben Stelle im Baum
  // vor Start- und Editor-Ansicht.
  const projectSync = <ProjectSync notify={notify} resourceHandlers={resourceHandlers} />;

  if (bootPhase !== "editor") {
    return (
      <>
        {projectSync}
        <BootScreen phase={bootPhase} setPhase={setBootPhase} files={files} notify={notify} />
      </>
    );
  }

  return (
    <>
    {projectSync}
    <div
      className="app"
      onDragEnter={onAppDragEnter}
      onDragOver={onAppDragOver}
      onDragLeave={onAppDragLeave}
      onDrop={onAppDrop}
    >
      <HiddenFileInputs
        dxfInputRef={dxfInputRef}
        stepInputRef={stepInputRef}
        ifcInputRef={ifcInputRef}
        imageInputRef={imageInputRef}
        projectFileInputRef={projectFileInputRef}
        projectTemplateFileInputRef={projectTemplateFileInputRef}
        openImportForAnyFile={ev.openImportForAnyFile}
        importStepFile={ev.importStepFile}
        importIfcFile={ev.importIfcFile}
        onImageOrPdfFileChosen={ev.onImageOrPdfFileChosen}
        onProjectFileChosen={ev.onProjectFileChosen}
        onProjectTemplateFileChosen={ev.onProjectTemplateFileChosen}
        notify={notify}
        onMeshImport={ev.onMeshImport}
      />
      {/* Schmale globale Leiste: Marke/Menü · Datei/Export/Einstellungen.
          Ansichts-/Zoom-/Darstellungs-Steuerung folgt direkt darunter
          (ViewRibbonTab, permanent — kein Tab-Umschalter mehr). */}
      <TopBar projectName={projectName} menuBar={menuBarEl} viewControls={viewControlsEl} />

      {/* Docks links/rechts, Andock-Zonen, schwebende Panels und Drag-Overlay um die Mitte → panels/DockArea.tsx. */}
      <DockArea
        layout={layout}
        baseHost={baseHost}
        modeFor={modeFor}
        setModeFor={setModeFor}
        measure={draft?.measure ?? null}
        dockDrag={dockDrag}
      >
          {/* Mitte-Spalte: Hauptansicht + Befehlszeile DARUNTER. So ist die
              Befehlszeile nur so breit wie der Viewport (nicht die ganze App),
              und die Docks nehmen die volle Body-Höhe ein (inkl. der Zeile). */}
          <div className="center-col">
          {/* Hauptansicht und Befehlszeile samt Griffen → views/ViewportCenter.tsx. */}
          <ViewportCenter
            content={contentProps}
            activeLevel={activeLevel}
            selection={selection}
            selectedDrawingId={selectedDrawingId}
            selectedCeilingId={selectedCeilingId}
            selectedRoomId={selectedRoomId}
            visibleCodes={visibleCodes}
            snap={snap}
            planScale={planScale}
            setDraft={setDraft}
            undo={undo}
            groupChanges={groupChanges}
            pa={pa}
            updateRoof={updateRoof}
            moveRoofGrip={moveRoofGrip}
            moveRoofBy={moveRoofBy}
            engineRef={engineRef}
            engine={engine}
            engineView={engineView}
            commandActive={commandActive}
            commandLineRef={commandLineRef}
            cmdTyped={cmdTyped}
            setCmdTyped={setCmdTyped}
            shortcutOverrides={shortcutOverrides}
            onSelectTool={onSelectTool}
            displayUnits={displayUnits}
            planViewRef={planViewRef}
            onCommandOption={ev.onCommandOption}
            cmdStillActive={ev.cmdStillActive}
            cmdSuggest={ev.cmdSuggest}
          />
          </div>
      </DockArea>

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

      {/* Dialoge und Overlays (Ressourcen, Import/Export, Einstellungen, Projektdatei …) → ui/AppDialogs.tsx. */}
      <AppDialogs
        applyChange={applyChange}
        layout={layout}
        setLayout={setLayout}
        activeLevel={activeLevel}
        activeCategoryCode={activeCategoryCode}
        scaleDenominator={scaleDenominator}
        marqueeColor={marqueeColor}
        setMarqueeColor={setMarqueeColor}
        snapColor={snapColor}
        setSnapColor={setSnapColor}
        dialogs={dialogs}
        files={files}
        modelImport={modelImport}
        settings={settings}
        planExport={planExport}
        pa={pa}
        resourceHandlers={resourceHandlers}
        selectionCount={selectionLockIds.length}
        engine={engine}
        setAliasOverrides={setAliasOverrides}
        setShortcutOverrides={setShortcutOverrides}
        pendingCopyMode={pendingCopyMode}
        setPendingCopyMode={setPendingCopyMode}
        commitCopyCount={commitCopyCount}
        stampEditorRoomId={stampEditorRoomId}
        setStampEditorRoomId={setStampEditorRoomId}
      />

      {/* Aktives Kontextmenü (genau eines), verdrahtet in menus/AppContextMenu.tsx. */}
      {menu && (
        <AppContextMenu
          menu={menu}
          selection={selection}
          setSelection={setSelection}
          selectedWallId={selectedWallId}
          layerClipboard={layerClipboard}
          setLayerClipboard={setLayerClipboard}
          drawingStyleClipboard={drawingStyleClipboard}
          setMenu={setMenu}
          setEditor={setEditor}
          openLayerSettings={openLayerSettings}
          planViewRef={planViewRef}
          pa={pa}
          selCmds={selCmds}
        />
      )}

      {/* Inline-Editor (Ebene bzw. Geschoss) — minimaler echter Editor, der live
          auf den State wirkt. Aus einem Menüpunkt geöffnet (menus/InlineEditors.tsx). */}
      {editor?.kind === "layer" && (
        <LayerInlineEditor
          editor={editor}
          onClose={() => setEditor(null)}
          patchCategory={patchCategory}
          onSaveColor={addColorToCustomPalette}
        />
      )}
      {editor?.kind === "level" && (
        <LevelInlineEditor editor={editor} onClose={() => setEditor(null)} patchLevel={patchLevel} />
      )}

      {/* Nicht-blockierende Kurzmeldungen (Ersatz für window.alert, siehe
          notifySlice.ts) — top-level, damit sie über allen Docks/Modals liegen. */}
      <Toast />
    </div>
    </>
  );
}
