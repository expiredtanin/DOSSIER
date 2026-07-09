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

import { useEffect, useMemo, useRef, useState } from "react";
import {
  collectVisibleCodes,
  flattenCategories,
  formatM,
  getWallType,
  wallTypeThickness,
} from "./model/types";
import { wallCorners } from "./model/geometry";
import { add, dot, leftNormal, normalize, scale, sub } from "./model/geometry";
import type {
  Ceiling,
  CeilingType,
  ContextObject,
  DoorType,
  Drawing2D,
  DrawingLevel,
  EdgeGrip,
  LayerCategory,
  Layout,
  OverrideRule,
  Project,
  Roof,
  Stair,
  StairType,
  Vec2,
  Wall,
  WallType,
  WindowType,
} from "./model/types";
import { generatePlan, generateSectionPlan } from "./plan/generatePlan";
import type { CategoryDisplayResolver } from "./plan/generatePlan";
import { computeSection } from "./plan/toSection";
import type { SectionOutput } from "./plan/toSection";
import { pushNativeScene, pushNativeWalls } from "./plan/nativeSync";
import { selectionHighlightLines } from "./plan/toWalls3d";
import { roofBaseElevation, roofGeometry } from "./geometry/roof";
import { parseDxf } from "./io/dxfParser";
import type { DxfImportResult } from "./io/dxfParser";
import { setDxfImportTrigger } from "./io/dxfImportHook";
import { ImportDialog, buildDrawings } from "./ui/ImportDialog";
import type { ImportDecision } from "./ui/ImportDialog";
import { ExportPdfDialog } from "./ui/ExportPdfDialog";
import type { ExportPdfDecision } from "./ui/ExportPdfDialog";
import { savePlanPdf } from "./export/exportPdf";
import { ExportDxfDialog } from "./ui/ExportDxfDialog";
import type { ExportDxfDecision } from "./ui/ExportDxfDialog";
import { savePlanDxf } from "./export/exportDxf";
import { exportScheduleCsv } from "./export/exportSchedule";
import { exportIfcSpf } from "./export/exportIfc";
import { exportObj, exportStl } from "./export/exportMesh";
import type { ScheduleKind } from "./export/exportSchedule";
import { SettingsDialog } from "./ui/SettingsDialog";
import { ExportSaveDialog } from "./ui/ExportSaveDialog";
import type { ExportSaveFormat } from "./ui/ExportSaveDialog";
import { PromptDialog } from "./ui/PromptDialog";
import { LockConflictDialog } from "./ui/LockConflictDialog";
import { Toast } from "./ui/Toast";
import { saveTextFile } from "./io/saveFile";
import {
  saveProjectFile,
  openProjectFileNative,
  acquireProjectLock,
  releaseProjectLock,
  registerLockAutoRelease,
  isTauriRuntime,
} from "./io/projectFile";
import type { LockInfo } from "./io/projectFile";
import { PlanView } from "./plan/PlanView";
import type {
  PlanViewHandle,
  PlanSelection,
  MarqueeSelection,
  GripHandlers,
} from "./plan/PlanView";
import { Viewport3D } from "./viewport/Viewport3D";
import type { DisplayResolver, ViewportContextInfo } from "./viewport/Viewport3D";
import type { Pick3dHit } from "./viewport/Wasm3DViewport";
import { ResourceManager } from "./ui/ResourceManager";
import type { ResourceManagerHandlers, TabId as ResourceTabId } from "./ui/ResourceManager";
import { LayoutSheetView } from "./ui/LayoutSheet";
import {
  createLayout,
  createLayoutFolder,
  createMasterLayout,
  createViewport,
  createAnnotation,
  deleteFolder as deleteLayoutFolder,
  deleteMasterFolder,
  moveLayoutToFolder,
  moveFolderToFolder,
  addViewport as addViewportToLayout,
  removeViewport as removeViewportFromLayout,
  patchViewport as patchViewportInLayout,
  addAnnotation as addAnnotationToLayout,
  removeAnnotation as removeAnnotationFromLayout,
  patchAnnotation as patchAnnotationInLayout,
} from "./panels/layoutModel";
import { saveFolderPdf } from "./export/layoutPdf";
import { HatchSwatch } from "./ui/hatchPreview";
import { TopBar, ViewRibbonTab, Ribbon3dTab } from "./ui/TopBar";
import { RibbonBar } from "./ui/ribbon/RibbonBar";
import type { RibbonTabId } from "./ui/ribbon/ribbonItems";
import { Dropdown } from "./ui/Dropdown";
import type { DropdownItem } from "./ui/Dropdown";
import { TextEditorDialog } from "./ui/TextEditorDialog";
import { RoomStampEditor } from "./panels/RoomStampEditor";
import { defaultRoomStamp } from "./model/roomStamp";
import type { DetailLevel, RenderMode, View3d, ViewType } from "./ui/TopBar";
import { StatusBar, type RendererMode } from "./ui/StatusBar";
import { getTool } from "./tools/tools";
import { applyAngleConstraint, computeSnap } from "./tools/snapping";
import {
  requiredPoints,
  transformPreview,
} from "./tools/transform";
import type { CopyMode, TransformOp, TransformSelection } from "./tools/transform";
import { DEFAULT_SNAP } from "./tools/types";
import type {
  MeasurementReadout,
  SnapResult,
  SnapSettings,
  ToolContext,
  ToolDraft,
  ToolHandlers,
  ToolId,
  ToolMods,
  ToolPointer,
  ToolState,
} from "./tools/types";
import { ContextMenu, MenuIcon } from "./ui/ContextMenu";
import type { ContextMenuItem } from "./ui/ContextMenu";
import { CommandLine } from "./ui/CommandLine";
import type { CommandLineHandle, CommandLineField, CommandLineOption } from "./ui/CommandLine";
import { CommandEngine } from "./commands/engine";
import type { EngineHost } from "./commands/engine";
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

// Globaler Store (Slices: project/selection/view/layout).
import { useStore } from "./state/appStore";
import {
  categoryLabel,
  drawingVertices,
  findCategory,
} from "./state/projectSlice";
import { reconcileLayout } from "./state/layoutSlice";

// Panel-System.
import { Dock } from "./panels/Dock";
import { FloatingPanel } from "./panels/FloatingPanel";
import { DragOverlay, usePanelDrag } from "./panels/panelDrag";
import { itemDisplay } from "./panels/displayMode";
import { PanelHostContext } from "./panels/types";
import type {
  DisplayMode,
  DockId,
  LayoutState,
  PanelHost,
} from "./panels/types";
import type { PanelHostValue } from "./panels/host";
import { deriveSelection } from "./state/selectionInfo";
import { centroid as roomCentroid } from "./geometry/roomArea";
import { docFromText, plainText } from "./text/richText";
import type { RichTextDoc } from "./text/richText";
import {
  deleteNamedLayout,
  listNamedLayouts,
  loadNamedLayout,
  saveLayout,
  saveNamedLayout,
} from "./panels/layout";
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
  applyOverrideRuleEnabled,
  captureViewSnapshot,
  readViewSnapshot,
  snapshotMatchesLiveState,
  type ViewSnapshotState,
} from "./state/viewSnapshots";
import {
  createViewSnapshotFolder,
  deleteFolder as deleteViewSnapshotFolder,
  moveSnapshotToFolder,
  moveFolder as moveViewSnapshotFolder,
} from "./state/viewSnapshotFolders";
// Seiteneffekt: registriert die zwei dockbaren Kern-Panels in der Registry.
import { BUILTIN_PANEL_IDS } from "./panels/builtinPanels";
import { DrawingTabs, deriveDrawings } from "./DrawingTabs";
import type { Drawing } from "./DrawingTabs";

/**
 * Offenes Kontextmenü — genau eine Quelle. `x/y` sind Viewport-Pixel (clientX/Y).
 *   • "layer"    — Rechtsklick auf eine Ebenen-Zeile (Kategorie-Code).
 *   • "level"    — Rechtsklick auf eine Zeichnungsebenen-Zeile (Ebenen-ID).
 *   • "plan"     — Rechtsklick im Grundriss (optional getroffene Wand).
 *   • "viewport" — Rechtsklick im 3D (optional getroffene Wand).
 */
type MenuState =
  | { kind: "layer"; code: string; x: number; y: number }
  | { kind: "level"; id: string; x: number; y: number }
  | { kind: "plan"; wallId: string | null; x: number; y: number }
  | { kind: "viewport"; wallId: string | null; x: number; y: number }
  | null;

/** Offener Inline-Editor (aus einem Menüpunkt). `x/y` = Anker in Viewport-Px. */
type EditorState =
  | { kind: "layer"; code: string; x: number; y: number }
  | { kind: "level"; id: string; x: number; y: number }
  | null;

/**
 * GUI-Werkzeug → Befehlsname der Engine. Die Zeichen-Werkzeuge der Palette sind
 * in Wahrheit Engine-Befehle: ein Klick auf das Werkzeug startet diesen Befehl
 * (statt das Legacy-Tool zu fahren). „select" hat (noch) keinen Befehl und bleibt
 * der Auswahl-Modus. „wall" ist jetzt ebenfalls ein Befehl (`wall`) — Klick und
 * getipptes „wall"/„wand" münden in denselben Befehl; der Legacy-Wand-Pfad ist
 * damit deaktiviert (siehe toolHandlers/onSelectTool).
 */
/**
 * Akzentfarbe der 3D-Auswahl-Hervorhebung (Umriss-Linien, WASM-Viewport, s.
 * `Content`/`selectionHighlightLines`). Kräftiges Orange — hebt sich vom
 * grauen Wand-/Deckenton, dem hellen Hidden-Line-Weiss und dem Bodenraster ab.
 */
const HIGHLIGHT_RGB: [number, number, number] = [1.0, 0.5, 0.1];

const TOOL_COMMAND: Partial<Record<ToolId, string>> = {
  wall: "wall",
  ceiling: "ceiling",
  window: "fenster",
  door: "tuer",
  stair: "stair",
  room: "room",
  line: "line",
  polyline: "polyline",
  rect: "rect",
  circle: "circle",
  arc: "arc",
  text: "text",
  textbox: "textbox",
};
/** Befehlsname für ein gekoppeltes Werkzeug (oder null, wenn keiner). */
function coupledCommandFor(id: ToolId): string | null {
  return TOOL_COMMAND[id] ?? null;
}

/** localStorage-Schlüssel der modularen Custom-Bar (Ribbon-Tab „Eigene"). */
const RIBBON_CUSTOM_KEY = "dossier.ribbon.customItems";

/** Persistierte Custom-Bar-Item-Schlüssel lesen (leer bei Fehler/Erststart). */
function loadCustomItems(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RIBBON_CUSTOM_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Custom-Bar-Item-Schlüssel persistieren (Fehler still schlucken). */
function saveCustomItems(items: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RIBBON_CUSTOM_KEY, JSON.stringify(items));
  } catch {
    // localStorage nicht verfügbar (privater Modus o. ä.) → ignorieren.
  }
}

/** Umriss (bbox) aller Drawing2D-Geometrien in Modell-Metern (null = leer). */
function drawingsBBox(
  drawings: Drawing2D[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const d of drawings) {
    const g = d.geom;
    if (g.shape === "line") { acc(g.a.x, g.a.y); acc(g.b.x, g.b.y); }
    else if (g.shape === "polyline") for (const p of g.pts) acc(p.x, p.y);
    else if (g.shape === "rect") { acc(g.min.x, g.min.y); acc(g.max.x, g.max.y); }
    else if (g.shape === "circle" || g.shape === "arc") {
      acc(g.center.x - g.r, g.center.y - g.r);
      acc(g.center.x + g.r, g.center.y + g.r);
    } else if (g.shape === "text") acc(g.at.x, g.at.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Bounding-Box (Modell-Meter) neu importierter Kontext-Objekte (Konturen/
 * Meshes/Terrain, z. B. aus dem Standort-Import-Dialog), als zwei Eckpunkte
 * für `PlanViewHandle.fitBounds` (Auto-Zoom auf Import). Ignoriert die
 * Z-Achse (reine 2D-Projektion, wie die Plan-Darstellung der Kontext-
 * Konturen in generatePlan.ts). Leere/degenerierte Eingabe → null.
 */
function contextObjectsBounds(objs: ContextObject[]): Vec2[] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const obj of objs) {
    if (obj.type === "contourSet") {
      for (const c of obj.contours) for (const p of c.pts) acc(p.x, p.y);
    } else {
      // importedMesh / terrainMesh: flaches (x,y,z…)-Array, Stride 3.
      const pos = obj.positions;
      for (let i = 0; i + 1 < pos.length; i += 3) acc(pos[i], pos[i + 1]);
    }
  }
  return Number.isFinite(minX)
    ? [{ x: minX, y: minY }, { x: maxX, y: maxY }]
    : null;
}

/** Ein Drawing2D um (dx,dy) in Modell-Metern verschieben (alle Formen). */
function translateDrawing(d: Drawing2D, dx: number, dy: number): Drawing2D {
  const mv = (p: Vec2): Vec2 => ({ x: p.x + dx, y: p.y + dy });
  const g = d.geom;
  switch (g.shape) {
    case "line": return { ...d, geom: { ...g, a: mv(g.a), b: mv(g.b) } };
    case "polyline": return { ...d, geom: { ...g, pts: g.pts.map(mv) } };
    case "rect": return { ...d, geom: { ...g, min: mv(g.min), max: mv(g.max) } };
    case "circle": return { ...d, geom: { ...g, center: mv(g.center) } };
    case "arc": return { ...d, geom: { ...g, center: mv(g.center) } };
    case "text": return { ...d, geom: { ...g, at: mv(g.at) } };
    default: return d;
  }
}

/**
 * Baut eine TransformSelection für GENAU EIN Element (Object-Info: Verschieben/
 * Drehen per Zahlenfeld, siehe onMoveSelectionBy/onRotateSelectionAround unten).
 * Deckt nur die vom Transform-Kern (tools/transform.ts) unterstützten Arten ab
 * — Decke/Öffnung/Treppe/Raum kennt er nicht, dort liefert die Funktion `null`
 * (Aufrufer macht dann No-op, wie bei onResizeSelection).
 */
function singleTransformSel(kind: string, id: string): TransformSelection | null {
  if (kind === "wall") return { wallIds: [id], drawingId: null };
  if (kind === "drawing2d") return { wallIds: [], drawingId: id };
  if (kind === "extrudedSolid") return { wallIds: [], drawingId: null, extrudedSolidId: id };
  if (kind === "column") return { wallIds: [], drawingId: null, columnId: id };
  return null;
}

export default function App() {
  // Sprachwechsel abonnieren: re-rendert den gesamten Baum, wenn die Sprache
  // umgeschaltet wird (alle Kinder lesen denselben modulweiten Zustand über t).
  useT();

  // ── Globaler Zustand aus dem Store (Slices: project/selection/view/layout) ─
  // Pro useStore-Aufruf EIN Feld selektieren (Referenz-Gleichheit, sonst
  // Endlosschleife). Actions leben ebenfalls im Zustand und sind referenzstabil.
  const project = useStore((s) => s.project);
  const setProject = useStore((s) => s.setProject);
  const notify = useStore((s) => s.notify);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const activeLevelId = useStore((s) => s.activeLevelId);
  const setActiveLevelId = useStore((s) => s.setActiveLevelId);
  const viewType = useStore((s) => s.viewType);
  const setViewType = useStore((s) => s.setViewType);

  // Schwebendes Ressourcen-Fenster (Overlay über allem). Transienter UI-State,
  // bleibt lokal. Wird über die Oberleiste geöffnet und über X / Hintergrund-
  // Klick / Esc geschlossen.
  const [resourcesOpen, setResourcesOpen] = useState(false);
  // Angeforderter Start-Tab des Ressourcen-Fensters (z. B. „doorStyles", wenn man
  // von einer gewählten Tür in den Typeditor springt).
  const [resourcesTab, setResourcesTab] = useState<ResourceTabId>("components");

  // Aktives Layout-Blatt im HAUPT-Viewport (DOSSIER A3, Phase 2b): Id des offenen
  // Layouts oder null (= normale Modell-Ansicht). Transienter UI-State; das
  // Layout selbst lebt im Projekt (project.layouts). Ist es gesetzt, zeigt der
  // Haupt-Viewport das Blatt (LayoutSheetView) statt Grundriss/3D.
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);

  // Modaler Import-Dialog (DXF/DWG). Offen, sobald eine Datei gewählt/fallen-
  // gelassen wurde; hält Dateiname, geparstes Ergebnis (null bei DWG) und das
  // DWG-Flag (kein Parser). null = kein Dialog offen. Transienter UI-State.
  const [importState, setImportState] = useState<{
    fileName: string;
    isDwg: boolean;
    parsed: DxfImportResult | null;
    // true, solange DWG noch geparst wird (WASM lädt/läuft).
    loading?: boolean;
  } | null>(null);
  // Modaler PDF-Export-Dialog (Grundriss → Vektor-PDF). true = offen.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDxfOpen, setExportDxfOpen] = useState(false);
  // Modales Einstellungs-Fenster (Darstellungsfarben + Projekt-Felder).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Offener Schnellexport-Dialog: Format (aus dem Menü) oder null = geschlossen.
  const [exportSaveFormat, setExportSaveFormat] = useState<ExportSaveFormat | null>(null);
  // Visuelles Drop-Feedback (dezenter Rahmen), solange eine Datei über die App
  // gezogen wird. Zählt dragenter/dragleave aus, um Flackern bei Kind-Elementen
  // zu vermeiden.
  const [dropActive, setDropActive] = useState(false);

  // ── Oberleisten-/Status-Zustand (View-State, kein Modell) ─────────────────
  // detail wirkt im Grundriss (Symbole + Schraffuren/Linien), renderMode in der
  // 3D-Ansicht (3 Modi), referenceLines schaltet die Wand-Achslinien.
  const detail = useStore((s) => s.detail);
  const setDetail = useStore((s) => s.setDetail);
  const renderMode = useStore((s) => s.renderMode);
  const setRenderMode = useStore((s) => s.setRenderMode);
  const view3d = useStore((s) => s.view3d);
  const setView3d = useStore((s) => s.setView3d);
  const fov = useStore((s) => s.fov);
  const setFov = useStore((s) => s.setFov);
  // Boden-Referenzraster im 3D-Viewport (wirkt nur im WASM/Nordstern-Pfad,
  // s. Wasm3DViewport.tsx) — Umschalter sitzt als Overlay-Button im Viewport.
  const grid3dVisible = useStore((s) => s.grid3dVisible);
  const setGrid3dVisible = useStore((s) => s.setGrid3dVisible);
  const planColorMode = useStore((s) => s.planColorMode);
  const setPlanColorMode = useStore((s) => s.setPlanColorMode);
  const referenceLines = useStore((s) => s.referenceLines);
  const setReferenceLines = useStore((s) => s.setReferenceLines);
  const lineMode = useStore((s) => s.lineMode);
  const setLineMode = useStore((s) => s.setLineMode);
  const marqueeColor = useStore((s) => s.marqueeColor);
  const setMarqueeColor = useStore((s) => s.setMarqueeColor);
  const snapColor = useStore((s) => s.snapColor);
  const setSnapColor = useStore((s) => s.setSnapColor);
  const scaleDenominator = useStore((s) => s.scaleDenominator);
  const setScaleDenominator = useStore((s) => s.setScaleDenominator);
  // LIVE Papier-Massstab-Nenner aus der View-Transform (PlanView meldet ihn);
  // null = keine Plan-Ansicht aktiv. Transienter UI-State, bleibt lokal.
  const [liveScale, setLiveScale] = useState<number | null>(null);
  // „Angewählter" Ausschnitt (View-Snapshot): bleibt gesetzt, solange der
  // Live-Zustand EXAKT dem Ausschnitt entspricht (siehe Effekt weiter unten).
  // Steuert die Footer-Bar + die Aktiv-Markierung im Ausschnitte-Panel.
  const [selectedViewSnapshotId, setSelectedViewSnapshotId] = useState<
    string | null
  >(null);
  // Cursor in Modell-Metern (aus der Plan-Ansicht) bzw. null (nicht über Plan).
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  // Live-Zoom in Prozent RELATIV zum angewandten Papier-Massstab: 100 % =
  // Live-Ansicht steht exakt im angewandten Massstab (liveScale == scaleDenominator).
  // Reinzoomen > 100 %, Rauszoomen < 100 %. Einzige Quelle: angewandter Nenner
  // (scaleDenominator) / Live-Nenner (liveScale). Ohne Live-Massstab (keine
  // Plan-Ansicht) Fallback 100 %.
  const zoomPercent =
    liveScale != null && liveScale > 0
      ? (scaleDenominator / liveScale) * 100
      : 100;

  // ── Zeichenwerkzeuge (transienter View-State; bleibt lokal) ───────────────
  // Aktives Werkzeug, Werkzeug-Parameter (Wandtyp/Kategorie/Linienstil), Snap-
  // Einstellungen sowie der laufende Werkzeug-Zustand (Ref, kein Re-Render je
  // Mausbewegung) und die Live-Vorschau (Draft → Overlay in PlanView).
  const [activeTool, setActiveTool] = useState<ToolId>("select");
  // Aktiver Ribbon-Tab (2D/3D/BIM/Ansichten). Liegt hier (nicht in der RibbonBar),
  // weil die Tab-Reiter in der TopBar-Zeile sitzen und der Ribbon-Inhalt darunter
  // — beide teilen sich denselben aktiven Tab.
  const [ribbonTab, setRibbonTab] = useState<RibbonTabId>("views");
  // Modulare Custom-Bar (Ribbon-Tab „Eigene"): persistierte Item-Schlüssel. Der
  // Picker im Tab wählt Werkzeuge/Befehle an/ab (localStorage-persistiert).
  const [customItems, setCustomItems] = useState<string[]>(loadCustomItems);
  const onToggleCustomItem = (key: string) => {
    setCustomItems((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      saveCustomItems(next);
      return next;
    });
  };
  const [activeWallTypeId, setActiveWallTypeId] = useState<string>(
    project.wallTypes[0].id,
  );
  const activeCategoryCode = useStore((s) => s.activeCategoryCode);
  const setActiveCategoryCode = useStore((s) => s.setActiveCategoryCode);
  const [activeLineStyleId] = useState<string>(project.lineStyles[0].id);
  const [snap, setSnap] = useState<SnapSettings>(DEFAULT_SNAP);
  const toolStateRef = useRef<ToolState>(getTool("select").init());
  const [draft, setDraft] = useState<ToolDraft | null>(null);
  // Aktive Transformation (Bewegen/Spiegeln/Drehen) auf der Auswahl — Vectorworks-
  // Stil mit U/I/O/P-Modusleiste. null = keine Transformation läuft.
  const [activeTransform, setActiveTransform] = useState<{
    op: TransformOp;
    copyMode: CopyMode;
    count: number;
    points: Vec2[];
  } | null>(null);
  // Letzter gesnappter Cursor der laufenden Transformation — für das Live-Feld
  // (Winkel/Distanz) der Befehlszeile (analog gripDragInfoRef beim Vertex-Drag).
  const transformDragInfoRef = useRef<{ cursor: Vec2 } | null>(null);
  // Kopienanzahl für array/distribute wird über einen PromptDialog erfasst
  // (window.prompt ist im Tauri-WKWebView deaktiviert) — `pendingCopyMode`
  // hält den Modus, während der Dialog offen ist.
  const [pendingCopyMode, setPendingCopyMode] = useState<"array" | "distribute" | null>(null);
  const requestCopyCount = (mode: "array" | "distribute") => setPendingCopyMode(mode);
  const commitCopyCount = (input: string) => {
    const n = Math.round(Number(input));
    if (Number.isFinite(n) && n >= 1 && pendingCopyMode) {
      const mode = pendingCopyMode;
      setActiveTransform((t) => (t ? { ...t, copyMode: mode, count: n } : t));
    }
    setPendingCopyMode(null);
  };

  // ── Auswahl (Store-Slice) ─────────────────────────────────────────────────
  const selectedWallIds = useStore((s) => s.selectedWallIds);
  const setSelectedWallIds = useStore((s) => s.setSelectedWallIds);
  // 2D-Auswahl ist jetzt eine MENGE (Marquee/Mehrfach). Für die bestehende
  // Einzel-Element-Maschinerie (Grips, Edit, Attribute, Object-Info) wird lokal
  // der „eine" gewählte Zeichnungs-ID abgeleitet (nur bei genau einem Element);
  // `setSelectedDrawingId` bleibt als bequeme Einzel-Setter-Hülle erhalten.
  const selectedDrawingIds = useStore((s) => s.selectedDrawingIds);
  const setSelectedDrawingIds = useStore((s) => s.setSelectedDrawingIds);
  const selectedDrawingId =
    selectedDrawingIds.length === 1 ? selectedDrawingIds[0] : null;
  const setSelectedDrawingId = (id: string | null) =>
    setSelectedDrawingIds(id ? [id] : []);
  // Zwischenablage für 2D-Zeichenelemente (Ctrl/Cmd+C/V). Kopiert die GEWÄHLTEN
  // Drawing2D tief; Einfügen legt Klone mit neuen IDs auf dem AKTIVEN Geschoss
  // (Zeichnungsebene) an — so lässt sich z. B. importiertes Mobiliar über
  // Geschosse hinweg wiederverwenden. Kategorie/Stil bleiben erhalten.
  const [drawingClipboard, setDrawingClipboard] = useState<Drawing2D[]>([]);
  // Bequemer Einzel-Selektor (erste gewählte Wand).
  const selectedWallId = selectedWallIds[0] ?? null;
  // Decken-Auswahl (MENGE); für die Einzel-Element-Maschinerie der „eine"
  // gewählte (bei genau einem Element).
  const selectedCeilingIds = useStore((s) => s.selectedCeilingIds);
  const setSelectedCeilingIds = useStore((s) => s.setSelectedCeilingIds);
  const selectedCeilingId =
    selectedCeilingIds.length === 1 ? selectedCeilingIds[0] : null;
  // Dach-Auswahl (MENGE); Einzel-Element bei genau einem gewählten Dach.
  const selectedRoofIds = useStore((s) => s.selectedRoofIds);
  const setSelectedRoofIds = useStore((s) => s.setSelectedRoofIds);
  const selectedRoofId = selectedRoofIds.length === 1 ? selectedRoofIds[0] : null;
  const updateRoof = useStore((s) => s.updateRoof);
  const moveRoofGrip = useStore((s) => s.moveRoofGrip);
  const moveRoofBy = useStore((s) => s.moveRoofBy);
  const selectedOpeningIds = useStore((s) => s.selectedOpeningIds);
  const setSelectedOpeningIds = useStore((s) => s.setSelectedOpeningIds);
  const selectedOpeningId =
    selectedOpeningIds.length === 1 ? selectedOpeningIds[0] : null;
  const selectedStairIds = useStore((s) => s.selectedStairIds);
  const setSelectedStairIds = useStore((s) => s.setSelectedStairIds);
  const selectedStairId =
    selectedStairIds.length === 1 ? selectedStairIds[0] : null;
  const selectedRoomIds = useStore((s) => s.selectedRoomIds);
  const setSelectedRoomIds = useStore((s) => s.setSelectedRoomIds);
  const selectedRoomId =
    selectedRoomIds.length === 1 ? selectedRoomIds[0] : null;
  const selectedExtrudedSolidIds = useStore((s) => s.selectedExtrudedSolidIds);
  const setSelectedExtrudedSolidIds = useStore((s) => s.setSelectedExtrudedSolidIds);
  const selectedExtrudedSolidId =
    selectedExtrudedSolidIds.length === 1 ? selectedExtrudedSolidIds[0] : null;
  const selectedColumnIds = useStore((s) => s.selectedColumnIds);
  const setSelectedColumnIds = useStore((s) => s.setSelectedColumnIds);
  const selectedColumnId =
    selectedColumnIds.length === 1 ? selectedColumnIds[0] : null;

  // ── Kontextmenüs (transienter UI-State, bleibt lokal) ─────────────────────
  // Eigenschaften-Zwischenablage des Ebenen-Kontextmenüs (Farbe + Linienstärke).
  const [layerClipboard, setLayerClipboard] = useState<{
    color: string;
    lw: number;
  } | null>(null);
  // Offenes Kontextmenü (genau eines) — Quelle bestimmt die Einträge.
  const [menu, setMenu] = useState<MenuState>(null);
  // Offener Inline-Editor (Ebene bzw. Geschoss) — aus einem Menüpunkt geöffnet.
  const [editor, setEditor] = useState<EditorState>(null);
  // Offener Raum-Stempel-Editor (Rich-Text) — per Doppelklick/Button geöffnet.
  const [stampEditorRoomId, setStampEditorRoomId] = useState<string | null>(null);
  // Text-Inhalt-Editor: Id des per Doppelklick bearbeiteten Text-2D-Elements.
  const [editTextId, setEditTextId] = useState<string | null>(null);

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
  // Verstecktes Datei-Input zum Laden eines Projekts (Datei-Burger „Öffnen").
  // Wird NUR im Browser-Pfad benutzt (ohne Tauri) — unter Tauri geht „Öffnen"
  // über den nativen Dialog (openProjectFileNative), der einen echten Pfad für
  // den Lock liefert (File-API im Browser hat keinen echten Dateipfad).
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  // Pfad + Lock-Status der aktuell offenen .obp/.json-Datei (nur Tauri; sonst
  // bleibt beides null/false — Browser-Blob-Pfad hat keinen echten Pfad).
  const openedProjectPathRef = useRef<string | null>(null);
  const projectLockOwnedRef = useRef(false);
  // Konflikt-Zustand: Datei ist in einer anderen Instanz gesperrt → Dialog mit
  // „Schreibgeschützt öffnen"/„Trotzdem erzwingen"/„Abbrechen" (kein window.confirm!).
  const [lockConflict, setLockConflict] = useState<{
    path: string;
    content: string;
    info: LockInfo | null;
  } | null>(null);

  // Best-effort Lock-Freigabe beim Fenster-Schliessen (sauberes Timing; der
  // OS-Lock fällt bei Prozessende/Absturz ohnehin automatisch weg). No-op ohne Tauri.
  useEffect(() => {
    registerLockAutoRelease(() => openedProjectPathRef.current);
  }, []);

  // Den DXF-Datei-Dialog-Öffner für den „import"-Befehl registrieren (entkoppelt
  // über den Modul-Hook). Beim Unmount wieder abmelden.
  useEffect(() => {
    setDxfImportTrigger(() => dxfInputRef.current?.click());
    return () => setDxfImportTrigger(null);
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
  // Zeichnungen, extrudierte Körper, Stützen) — sonst wirken die Kürzel m/s/d nur
  // auf Wände/2D, obwohl `commitTransform` auch Extrude/Stütze bewegt.
  const transformSel: TransformSelection = {
    wallIds: selectedWallIds,
    drawingId: selectedDrawingId,
    extrudedSolidId: selectedExtrudedSolidId,
    columnId: selectedColumnId,
  };
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
    setDraft({ preview, vertices: tr.points, snap: snapResult });
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
          selection: {
            wallIds: c.selectedWallIds,
            drawingId: c.selectedDrawingId,
            drawingIds: c.selectedDrawingIds,
            extrudedSolidId: c.selectedExtrudedSolidId,
            columnId: c.selectedColumnId,
          },
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
      commit: (mutate) => cmdLatest.current.setProject(mutate),
      isFloor: () => cmdLatest.current.activeLevel.kind === "floor",
    };
    engineRef.current = new CommandEngine(host);
  }
  const engine = engineRef.current;

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

  // ── GUI-Werkzeug ↔ Befehls-Engine (ein Eingabe-Hub) ───────────────────────
  // Ein Klick auf ein gekoppeltes Zeichen-Werkzeug (Wand/Linie/Rechteck/Polylinie)
  // STARTET den passenden Befehl in der Engine und fokussiert das Befehlsfeld
  // („Dialog drin"). „Auswahl" beendet einen laufenden Befehl (Auswahl-Modus).
  const onSelectTool = (id: ToolId) => {
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
      !!selectedExtrudedSolidId ||
      !!selectedColumnId;
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
  const onWorkplanePoint = (kind: "move" | "pick", model: Vec2) => {
    const eng = engineRef.current;
    if (!eng?.isActive()) return;
    if (kind === "move") eng.move(model);
    else eng.pick(model);
  };
  const onWorkplaneConfirm = () => {
    const eng = engineRef.current;
    if (eng?.isActive()) eng.confirm();
  };

  // Globaler Tab-Handler: läuft ein Befehl MIT Feldern (§2.7), zyklt Tab das
  // aktive Feld (Präzisionseingabe), ohne den Fokus zu stehlen — so kann man bei
  // der Maus bleiben. Sonst fokussiert/öffnet Tab die Command-Line. Gleicher
  // INPUT/TEXTAREA/contentEditable-Guard wie die bestehenden keydown-Handler
  // (das CommandLine-Input selbst behandelt Tab eigenständig).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      const eng = engineRef.current;
      if (eng?.isActive() && eng.hasFields()) {
        eng.cycleField();
        return;
      }
      // (c) Läuft ein Vertex-Griff-Drag, öffnet/zyklt Tab das Editier-Feld
      // (Länge/Winkel relativ zur Nachbarecke). Beim ersten Tab wird zusätzlich
      // das Befehlsfeld fokussiert, damit man den Zahlenwert direkt tippen kann.
      if (gripDragInfoRef.current) {
        const wasOpen = gripEditRef.current !== null;
        cycleGripEditFieldRef.current?.();
        if (!wasOpen) commandLineRef.current?.focus();
        return;
      }
      commandLineRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Globaler Undo/Redo-Shortcut: Ctrl+Z / Cmd+Z, Ctrl+Shift+Z / Cmd+Shift+Z
  // bzw. Ctrl+Y für redo. Gleicher Eingabe-Guard wie die übrigen globalen
  // keydown-Handler (Tab-Zyklus, Zahlen-Shortcuts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!mod || (key !== "z" && key !== "y")) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (key === "y" || (key === "z" && e.shiftKey)) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Nummern-Shortcuts für Zeichenwerkzeuge (Vectorworks-Stil): 2 Linie, 4
  // Rechteck, 5 Polylinie, 6 Wand, 7 Decke, 8 Fenster, 9 Türe, 0 Raum. Nur auf
  // Geschoss-Tabs, nicht beim Tippen in Feldern und nicht mit Modifikator
  // (Ctrl/Cmd/Alt bleiben frei). 1 (Text) und 3 (Kreis) sind bewusst noch
  // unbelegt — dafür fehlt bislang ein Werkzeug. Der Handler wird einmal
  // registriert und liest die aktuelle Auswahl-Funktion/Ebenen-Art über ein Ref.
  const toolShortcutRef = useRef({
    onSelectTool,
    floor: activeLevel.kind === "floor",
  });
  toolShortcutRef.current = {
    onSelectTool,
    floor: activeLevel.kind === "floor",
  };
  useEffect(() => {
    const MAP: Record<string, ToolId> = {
      "2": "line",
      "4": "rect",
      "5": "polyline",
      "6": "wall",
      "7": "ceiling",
      "8": "window",
      "9": "door",
      "0": "room",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      const id = MAP[e.key];
      if (!id) return;
      if (!toolShortcutRef.current.floor) return; // Werkzeuge nur auf Geschossen
      e.preventDefault();
      toolShortcutRef.current.onSelectTool(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tastatur für aktive Zeichenwerkzeuge: Esc verwirft den Entwurf (bzw. schaltet
  // im Ruhezustand zurück auf Auswahl), Enter schließt mehrteilige Werkzeuge ab,
  // Backspace nimmt den letzten Punkt zurück. In echten Eingaben inaktiv.
  useEffect(() => {
    if (activeTool === "select") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      // Läuft ein gekoppelter Befehl (Linie/Rechteck/Polylinie über die Engine),
      // gehören Esc/Enter/Backspace der Engine bzw. dem Befehlsfeld — der Legacy-
      // Werkzeug-Pfad bleibt stumm (keine doppelte Mechanik).
      if (engineRef.current?.isActive()) return;
      const tool = getTool(activeTool);
      const drawing = toolStateRef.current.phase !== "idle";
      if (e.key === "Escape") {
        if (drawing) {
          const [st] = tool.onCancel(toolStateRef.current);
          toolStateRef.current = st;
          setDraft(null);
        } else {
          setActiveTool("select");
        }
        e.preventDefault();
      } else if (e.key === "Enter") {
        const [st, res] = tool.onCommitGesture(toolStateRef.current, toolCtx);
        toolStateRef.current = st;
        if (res.commit) setProject(res.commit);
        setDraft(null);
        if (res.done) toolStateRef.current = tool.init();
        e.preventDefault();
      } else if (e.key === "Backspace" && tool.onUndoPoint) {
        const [st, res] = tool.onUndoPoint(toolStateRef.current, toolCtx);
        toolStateRef.current = st;
        setDraft(res.draft);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, toolCtx]);

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
  // Bewegpunkt (Move-Handle) einer Treppe: liegt auf der Treppe (Mitte des
  // ersten Laufs bei gerade/L, Zentrum bei Wendel) und verschiebt beim Ziehen
  // die GANZE Treppe (moveStairBy mit dem Delta). Ein einzelner, gut sichtbarer
  // Griff — analog zum Öffnungs-Mittelpunkt.
  const stairMoveHandle = (st: Stair): Vec2 => {
    if (st.shape === "spiral") return st.center ?? st.start;
    const d = normalize(st.dir);
    return add(st.start, scale(d, st.runLength / 2));
  };
  const grips: Vec2[] = useMemo(() => {
    // Öffnung (Fenster/Tür): EIN Mittelpunkt-Griff auf der Wandachse. Ziehen
    // verschiebt die Öffnung entlang der Wirts-Wand (siehe applyGrip →
    // `position`). Nur bei genau einer selektierten Öffnung (Auswahl exklusiv).
    if (selectedOpeningId) {
      const op = (project.openings ?? []).find((o) => o.id === selectedOpeningId);
      const w = op && project.walls.find((x) => x.id === op.hostWallId);
      if (op && w) {
        const axis = normalize(sub(w.end, w.start));
        return [add(w.start, scale(axis, op.position + op.width / 2))];
      }
      return [];
    }
    // Treppe: EIN Bewegpunkt (siehe stairMoveHandle); Ziehen verschiebt die
    // ganze Treppe (applyGrip → moveStairBy). Auswahl exklusiv.
    if (selectedStairId) {
      const st = (project.stairs ?? []).find((s) => s.id === selectedStairId);
      return st ? [stairMoveHandle(st)] : [];
    }
    if (selectedDrawing) return drawingVertices(selectedDrawing);
    if (selectedWallIds.length === 1 && !selectedDrawingId) {
      const w = project.walls.find((x) => x.id === selectedWallIds[0]);
      if (w) return [w.start, w.end];
    }
    // Decke: die Umriss-Vertices als Griffe (nur bei genau einer gewählten Decke).
    if (selectedCeiling && !selectedDrawingId && selectedWallIds.length === 0) {
      return [...selectedCeiling.outline];
    }
    // Raum: die Umriss-Vertices als Griffe (nur bei genau einem gewählten Raum).
    if (
      selectedRoom &&
      !selectedDrawingId &&
      selectedWallIds.length === 0 &&
      !selectedCeiling
    ) {
      return [...selectedRoom.boundary];
    }
    return [];
  }, [
    selectedDrawing,
    selectedCeiling,
    selectedRoom,
    selectedOpeningId,
    selectedStairId,
    selectedWallIds,
    selectedDrawingId,
    project.walls,
    project.openings,
    project.stairs,
  ]);

  // ── Kanten-/Seiten-Griffe (Edge Grips) ───────────────────────────────────
  // Pro Seite des selektierten Elements ein Griff: Kanten-Mittelpunkt + nach
  // AUSSEN zeigende Einheitsnormale + die beiden Vertex-Indizes (passend zur
  // `grips`-/`drawingVertices`-Reihenfolge). Die Außenrichtung wird über das
  // Vorzeichen des Skalarprodukts der Kanten-Normale mit (mid − centroid)
  // gewählt (vom Polygon-Schwerpunkt weg).
  //  • rect: 4 Kanten (geschlossen).
  //  • polyline mit `closed`: Kanten zwischen aufeinanderfolgenden Vertices
  //    inkl. Schlusskante (letzter → erster).
  //  • Wand: eine Kante [0,1]; Außennormale = leftNormal der Achse. Ziehen
  //    verschiebt beide Enden (ganze Wand senkrecht).
  //  • offene Polylinie/Linie: je Segment ein Kanten-Griff. Ziehen verschiebt DAS
  //    Segment (seine beiden Endpunkte) um das volle Drag-Delta — die geteilten
  //    Ecken wandern mit, die Nachbar-Segmente dehnen sich nach (Parallel-
  //    Verschieben EINER Kante einer komplexen Polylinie, §Task B).
  const edgeGrips: EdgeGrip[] = useMemo(() => {
    // Geschlossener Ring aus Vertices → Kanten-Griffe mit Außennormale.
    const ringEdges = (verts: Vec2[]): EdgeGrip[] => {
      const n = verts.length;
      if (n < 3) return [];
      // Schwerpunkt (Mittel der Eckpunkte) als Innenbezug.
      let cx = 0, cy = 0;
      for (const v of verts) { cx += v.x; cy += v.y; }
      const centroid: Vec2 = { x: cx / n, y: cy / n };
      const out: EdgeGrip[] = [];
      for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];
        const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const edge = sub(b, a);
        let nrm = normalize(leftNormal(edge));
        // Nach außen orientieren: Normale soll von centroid → mid weisen.
        const outward = sub(mid, centroid);
        if (nrm.x * outward.x + nrm.y * outward.y < 0) nrm = scale(nrm, -1);
        out.push({ mid, normal: nrm, aIndex: i, bIndex: (i + 1) % n });
      }
      return out;
    };
    // Offene Kette (Linie/offene Polylinie) → ein Griff je Segment, OHNE
    // Schlusskante. `normal` dient nur der Griff-Darstellung (leftNormal der
    // Kante); die Bewegung ist frei (volles Delta), nicht auf die Normale
    // beschränkt — daher `free: true`.
    const openEdges = (verts: Vec2[]): EdgeGrip[] => {
      const n = verts.length;
      if (n < 2) return [];
      const out: EdgeGrip[] = [];
      for (let i = 0; i < n - 1; i++) {
        const a = verts[i];
        const b = verts[i + 1];
        const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const nrm = normalize(leftNormal(sub(b, a)));
        out.push({ mid, normal: nrm, aIndex: i, bIndex: i + 1, free: true });
      }
      return out;
    };
    if (selectedDrawing) {
      const g = selectedDrawing.geom;
      if (g.shape === "rect") return ringEdges(grips);
      if (g.shape === "polyline" && g.closed) return ringEdges(grips);
      if (g.shape === "polyline" && !g.closed) return openEdges(grips);
      if (g.shape === "line") return openEdges(grips);
      return [];
    }
    if (selectedWallIds.length === 1 && !selectedDrawingId) {
      const w = project.walls.find((x) => x.id === selectedWallIds[0]);
      if (w) {
        const mid: Vec2 = { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
        const nrm = normalize(leftNormal(sub(w.end, w.start)));
        return [{ mid, normal: nrm, aIndex: 0, bIndex: 1 }];
      }
    }
    // Decke: geschlossener Ring aus dem Umriss.
    if (selectedCeiling && !selectedDrawingId && selectedWallIds.length === 0) {
      return ringEdges(grips);
    }
    // Raum: geschlossener Ring aus dem Umriss.
    if (
      selectedRoom &&
      !selectedDrawingId &&
      selectedWallIds.length === 0 &&
      !selectedCeiling
    ) {
      return ringEdges(grips);
    }
    return [];
  }, [
    selectedDrawing,
    selectedCeiling,
    selectedRoom,
    grips,
    selectedWallIds,
    selectedDrawingId,
    project.walls,
  ]);

  // Snapping beim Griff-Ziehen: das gezogene Element selbst aus den Quellen
  // nehmen (sonst fängt der Punkt an sich selbst). Live-Mutation über setProject.
  // Zuletzt angewandter Kanten-Offset während eines Edge-Grip-Drags (Anker).
  // null = kein laufender Drag; der erste Move-Event verankert nur (kein Sprung).
  const edgeDragOffsetRef = useRef<number | null>(null);
  // Freies Kanten-Ziehen (offene Polylinie/Linie): letzter roher Cursor, gegen den
  // das inkrementelle 2D-Delta gebildet wird. null = Drag noch nicht verankert.
  const edgeFreeLastRef = useRef<Vec2 | null>(null);
  // Körper-Verschieben (2D): koinzidente Endpunkte ANDERER gewählter Elemente, die
  // an einer Ecke des verschobenen Elements hängen, werden um dasselbe Delta
  // mitgeführt (gemeinsame Ecke bleibt verbunden). Lazy beim ersten Move-Event
  // bestimmt (Snapshot der Selektion), je Drag in onGripEnd zurückgesetzt. null =
  // noch nicht bestimmt.
  const moveCoincidentRef = useRef<
    | { drawingId: string | null; wallId: string | null; index: number; pos: Vec2 }[]
    | null
  >(null);
  // Eckpunkte eines selektierten Elements (Wand: start/end; 2D: drawingVertices).
  const elementCorners = (drawingId: string | null, wallId: string | null): Vec2[] => {
    if (drawingId) {
      const d = project.drawings2d.find((x) => x.id === drawingId);
      return d ? drawingVertices(d) : [];
    }
    if (wallId) {
      const w = project.walls.find((x) => x.id === wallId);
      return w ? [w.start, w.end] : [];
    }
    return [];
  };
  // Koinzidente Sibling-Vertices (unter den ÜBRIGEN gewählten Elementen) an JEDER
  // Ecke des verschobenen Elements. Toleranz wie beim 3D-Drag (gemeinsame Ecke).
  const COINCIDENT_TOL_2D = 0.05; // m
  const findMoveCoincident2D = (
    selfDrawingId: string | null,
    selfWallId: string | null,
  ): { drawingId: string | null; wallId: string | null; index: number; pos: Vec2 }[] => {
    const corners = elementCorners(selfDrawingId, selfWallId);
    if (corners.length === 0) return [];
    const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) <= COINCIDENT_TOL_2D;
    const seen = new Set<string>();
    const out: { drawingId: string | null; wallId: string | null; index: number; pos: Vec2 }[] = [];
    const add = (drawingId: string | null, wallId: string | null, index: number, pos: Vec2) => {
      const key = `${drawingId ?? ""}|${wallId ?? ""}|${index}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ drawingId, wallId, index, pos: { ...pos } });
    };
    for (const corner of corners) {
      for (const id of selectedWallIds) {
        if (id === selfWallId) continue;
        const w = project.walls.find((x) => x.id === id);
        if (!w) continue;
        if (near(corner, w.start)) add(null, id, 0, w.start);
        if (near(corner, w.end)) add(null, id, 1, w.end);
      }
      for (const id of selectedDrawingIds) {
        if (id === selfDrawingId) continue;
        const d = project.drawings2d.find((x) => x.id === id);
        if (!d) continue;
        drawingVertices(d).forEach((v, i) => {
          if (near(corner, v)) add(id, null, i, v);
        });
      }
    }
    return out;
  };
  // ── (c) Präzise Werteingabe beim Editieren (Tab im Vertex-Griff-Drag) ───────
  // Editieren läuft AD-HOC (gripHandlers → moveGripOf), NICHT durch die Engine.
  // Damit „Tab → Länge/Winkel" wie beim Zeichnen funktioniert, ohne die Engine
  // umzubauen, hält App einen kleinen FELD-Controller, der NUR während eines
  // Vertex-Griff-Drags aktiv ist: er belegt das Befehlsfeld (Prompt/Felder/
  // Eingabe) und liefert gelockte Länge/Winkel relativ zum Anker (Nachbarecke).
  // `onGripMove` liest diese Locks und zwingt den Zielpunkt darauf — so setzt ein
  // getippter Wert den exakten Endpunkt. Foundation: heute 2D-Vertex; dieselbe
  // Lock-Auflösung (polar um den Anker) ist auf 3D-Vertex/Körper erweiterbar.
  const [gripEdit, setGripEdit] = useState<{
    /** Fixer Bezug (Nachbarecke), relativ zu dem Länge/Winkel gelten. */
    anchor: Vec2;
    /** Aktives Tab-Feld (zyklt length ↔ angle). */
    active: "length" | "angle";
    /** Gelockte Werte (getippt). length in m, angle in Grad. */
    locks: { length?: number; angle?: number };
  } | null>(null);
  // Live-Spiegel für Handler ohne Re-Render-Abhängigkeit (Drag liest synchron).
  const gripEditRef = useRef<typeof gripEdit>(null);
  gripEditRef.current = gripEdit;
  // Letzter roher Cursor des laufenden Vertex-Drags (für die Lock-Auflösung beim
  // Tippen, wenn gerade kein Move-Event kommt). Plus der gezogene Griff-Index.
  const gripDragInfoRef = useRef<{ index: number; raw: Vec2 } | null>(null);

  // Endpunkt aus Anker + (gelockten/Live-)Länge/Winkel — wie lineEndFromFields,
  // hier für den Vertex-Drag. Ungelockte Größen folgen dem rohen Cursor `raw`.
  const gripEditPoint = (
    anchor: Vec2,
    locks: { length?: number; angle?: number },
    raw: Vec2,
  ): Vec2 => {
    const DEG = Math.PI / 180;
    const dx = raw.x - anchor.x;
    const dy = raw.y - anchor.y;
    const length = locks.length != null ? locks.length : Math.hypot(dx, dy);
    const angleDeg = locks.angle != null ? locks.angle : (Math.atan2(dy, dx) * 180) / Math.PI;
    const a = angleDeg * DEG;
    return { x: anchor.x + Math.cos(a) * length, y: anchor.y + Math.sin(a) * length };
  };

  // Felder fürs Befehlsfeld während des Vertex-Drags (Live ODER gelockt).
  const gripEditFields = (): {
    id: string;
    labelKey: string;
    value: number | null;
    locked: boolean;
    active: boolean;
  }[] => {
    const ge = gripEdit;
    const info = gripDragInfoRef.current;
    if (!ge || !info) return [];
    const dx = info.raw.x - ge.anchor.x;
    const dy = info.raw.y - ge.anchor.y;
    const liveLen = Math.hypot(dx, dy);
    const liveAng = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
    return [
      {
        id: "length",
        labelKey: "cmd.field.length",
        value: ge.locks.length ?? liveLen,
        locked: ge.locks.length != null,
        active: ge.active === "length",
      },
      {
        id: "angle",
        labelKey: "cmd.field.angle",
        value: ge.locks.angle ?? liveAng,
        locked: ge.locks.angle != null,
        active: ge.active === "angle",
      },
    ];
  };

  // Stabiler Ref auf cycleGripEditField (der globale Tab-Handler hat leere Deps).
  const cycleGripEditFieldRef = useRef<() => void>(() => {});
  // Tab im Vertex-Drag: Feld-Controller öffnen/zyklen (length ↔ angle).
  const cycleGripEditField = () => {
    const info = gripDragInfoRef.current;
    if (!info) return;
    const refIndex = info.index > 0 ? info.index - 1 : grips.length > 1 ? 1 : -1;
    const anchor = refIndex >= 0 ? grips[refIndex] : null;
    if (!anchor) return; // ohne Anker keine polare Eingabe möglich
    setGripEdit((prev) =>
      prev
        ? { ...prev, active: prev.active === "length" ? "angle" : "length" }
        : { anchor, active: "length", locks: {} },
    );
  };
  cycleGripEditFieldRef.current = cycleGripEditField;

  // Getippte Zahl im Vertex-Drag: aktives Feld locken, aufs nächste vorrücken und
  // den Zielpunkt sofort mit dem gelockten Wert neu setzen.
  const submitGripEditValue = (value: number) => {
    const ge = gripEditRef.current;
    const info = gripDragInfoRef.current;
    if (!ge || !info) return;
    const locks = { ...ge.locks, [ge.active]: value };
    const next = ge.active === "length" ? "angle" : "length";
    setGripEdit({ ...ge, locks, active: next });
    // Zielpunkt mit dem frischen Lock anwenden (live, ohne Maus-Bewegung).
    const pt = gripEditPoint(ge.anchor, locks, info.raw);
    applyGrip(info.index, pt);
  };

  // Editier-Dispatch: bei gewählter Decke auf die Decken-Aktionen umleiten, sonst
  // auf die Wand/2D-Aktionen. So teilen Plan- UND 3D-Griffe denselben Pfad.
  const applyGrip = (index: number, pt: Vec2) => {
    // Öffnung: den gezogenen Punkt auf die Wandachse projizieren → neue
    // `position` (Abstand des ersten Pfostens vom Wand-Start), sodass die
    // Öffnung entlang der Wand gleitet. Griff sitzt in der Öffnungsmitte, daher
    // width/2 abziehen; auf [0, Wandlänge − Breite] klemmen (Öffnung bleibt drin).
    if (selectedOpeningId) {
      const op = (project.openings ?? []).find((o) => o.id === selectedOpeningId);
      const w = op && project.walls.find((x) => x.id === op.hostWallId);
      if (op && w) {
        const d = sub(w.end, w.start);
        const len = Math.hypot(d.x, d.y);
        if (len > 1e-9) {
          const axis = scale(d, 1 / len);
          const t = dot(sub(pt, w.start), axis);
          const pos = Math.max(0, Math.min(len - op.width, t - op.width / 2));
          updateOpening(op.id, { position: pos });
        }
      }
      return;
    }
    // Treppe: den Bewegpunkt verfolgen → ganze Treppe um das Delta (Ziel −
    // aktueller Handle) verschieben. Handle wird identisch zu grips gebildet,
    // sodass er nach dem Move exakt unter dem Cursor sitzt.
    if (selectedStairId) {
      const st = (project.stairs ?? []).find((s) => s.id === selectedStairId);
      if (st) moveStairBy(st.id, sub(pt, stairMoveHandle(st)));
      return;
    }
    if (selectedRoomId) moveRoomGrip(selectedRoomId, index, pt);
    else if (selectedCeilingId) moveCeilingGrip(selectedCeilingId, index, pt);
    else moveGripOf(selectedDrawingId, selectedWallId, index, pt);
  };
  const applyEdge = (aIndex: number, bIndex: number, delta: Vec2) => {
    if (selectedRoomId) moveRoomEdge(selectedRoomId, aIndex, bIndex, delta);
    else if (selectedCeilingId) moveCeilingEdge(selectedCeilingId, aIndex, bIndex, delta);
    else moveEdgeOf(selectedDrawingId, selectedWallId, aIndex, bIndex, delta);
  };

  const gripHandlers = {
    onGripMove: (index: number, raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
      // (c) Vertex-Drag mit aktivem Feld-Controller + Locks: den Zielpunkt polar
      // aus Anker + gelockter Länge/Winkel bilden (ungelockt folgt dem Cursor).
      const ge = gripEditRef.current;
      gripDragInfoRef.current = { index, raw };
      if (ge && (ge.locks.length != null || ge.locks.angle != null)) {
        const pt = gripEditPoint(ge.anchor, ge.locks, raw);
        applyGrip(index, pt);
        setDraft({ preview: [], vertices: [], snap: null });
        return;
      }
      const snapProject: Project = selectedRoomId
        ? { ...project, rooms: (project.rooms ?? []).filter((r) => r.id !== selectedRoomId) }
        : selectedCeilingId
        ? { ...project, ceilings: (project.ceilings ?? []).filter((c) => c.id !== selectedCeilingId) }
        : selectedDrawingId
        ? { ...project, drawings2d: project.drawings2d.filter((d) => d.id !== selectedDrawingId) }
        : { ...project, walls: project.walls.filter((w) => w.id !== selectedWallId) };
      // Bezugspunkt für Shift-Ortho: ein Nachbar-Griff (festes Ende), relativ zu
      // dem die Bewegung auf H/V eingerastet wird.
      const refIndex = index > 0 ? index - 1 : grips.length > 1 ? 1 : -1;
      const anchor = refIndex >= 0 ? grips[refIndex] : null;
      // Shift = Ortho-Lock: den gezogenen Punkt auf H/V gegenüber dem FIXEN Anker
      // zwingen (Achse = die nähere; applyAngleConstraint mit 90°, wie Ortho beim
      // Zeichnen). Der Lock dominiert (kein Snap), damit die Endkoordinate
      // garantiert eine Achse mit dem Anker teilt — identisch zum 3D-Vertex-Drag.
      if (mods.shift && anchor) {
        const pt = applyAngleConstraint(anchor, raw, 90);
        applyGrip(index, pt);
        setDraft({ preview: [], vertices: [], snap: null });
        return;
      }
      const snapResult = computeSnap({
        raw,
        project: snapProject,
        levelId: activeLevel.id,
        visibleCodes,
        settings: snap,
        draftPoints: [],
        lastPoint: anchor,
        pxPerMeter,
        shift: mods.shift,
        ctrl: mods.ctrl,
      });
      const pt = snapResult?.point ?? raw;
      applyGrip(index, pt);
      setDraft({ preview: [], vertices: [], snap: snapResult });
    },
    onMoveBody: (
      delta: Vec2,
      target?: { wallId?: string; drawingId?: string },
      mods?: ToolMods,
    ) => {
      // Shift = Ortho: das Delta auf die dominante Achse (H/V) zwingen —
      // dieselbe Regel wie beim freien Kanten-Zug (onEdgeMove) und beim
      // Vertex-Griff (onGripMove). Bisher wirkte Shift beim Körper-Verschieben
      // (Wand/2D-Element/Decke/Treppe/Raum als Ganzes) gar nicht (Nutzer-Report
      // 2026-07-06) — `mods` kam von PlanView schlicht nicht bis hierher.
      if (mods?.shift) {
        if (Math.abs(delta.x) >= Math.abs(delta.y)) delta = { x: delta.x, y: 0 };
        else delta = { x: 0, y: delta.y };
      }
      // Decke: ganzen Umriss verschieben (kein Multi-Koinzidenz-Handling nötig).
      if (selectedCeilingId && !target) {
        moveCeilingBy(selectedCeilingId, delta);
        return;
      }
      // Treppe: ganzen Antritt (+ Zentrum) verschieben.
      if (selectedStairId && !target) {
        moveStairBy(selectedStairId, delta);
        return;
      }
      // Raum: ganzen Umriss (+ Stempel-Anker) verschieben.
      if (selectedRoomId && !target) {
        moveRoomBy(selectedRoomId, delta);
        return;
      }
      // Gegriffenes Element: bei Mehrfachauswahl das unter dem Cursor (target),
      // sonst das einzeln selektierte. Wand UND 2D schließen sich aus.
      const moveDrawingId = target ? target.drawingId ?? null : selectedDrawingId;
      const moveWallId = target ? target.wallId ?? null : selectedWallId;
      moveElementByOf(moveDrawingId, moveWallId, delta);
      // Beim ersten Move-Event die Koinzidenz-Gruppe einmalig bestimmen (Snapshot
      // VOR der ersten Mutation der Siblings). Danach inkrementell mitführen.
      if (moveCoincidentRef.current === null) {
        moveCoincidentRef.current = findMoveCoincident2D(moveDrawingId, moveWallId);
      }
      for (const c of moveCoincidentRef.current) {
        c.pos = { x: c.pos.x + delta.x, y: c.pos.y + delta.y };
        moveGripOf(c.drawingId, c.wallId, c.index, c.pos);
      }
    },
    // Kanten-Griff ziehen. Zwei Verhalten:
    //  • free (offene Polylinie/Linie, §Task B): das Segment folgt dem VOLLEN
    //    Cursor-Delta — beide Endpunkte wandern gleich, die geteilten Ecken ziehen
    //    die Nachbar-Segmente nach. Shift = Ortho (H/V) auf das Gesamt-Delta.
    //  • sonst (rect/geschlossene Polylinie/Wand): NUR die Komponente senkrecht
    //    zur Kante (Seite verschiebt sich parallel nach außen/innen). Fängt an
    //    eingeschalteten Geometrie-Snaps (Endpunkt/Mittelpunkt/Schnittpunkt/…);
    //    ohne Geometrie-Snap wird der Offset wie bisher aufs Raster gerundet.
    onEdgeMove: (edge: EdgeGrip, raw: Vec2, pxPerMeter: number, mods: ToolMods) => {
      if (edge.free) {
        // Freier Fall arbeitet mit einem inkrementellen Cursor-DELTA (nicht
        // einem absoluten Punkt) — eine Geometrie-Snap-Projektion auf die
        // Normale ergibt hier keinen Sinn, da es keine feste Kanten-Normale
        // gibt, an die sich ein gefangener Punkt anlehnen könnte. Bleibt beim
        // bisherigen Raster-Delta-Verhalten.
        //
        // Inkrementelles 2D-Delta gegen den letzten rohen Cursor. Erster Event
        // verankert nur (kein Sprung, da der Griff am Kanten-Mittelpunkt sitzt).
        const last = edgeFreeLastRef.current;
        edgeFreeLastRef.current = raw;
        if (last === null) return;
        let dx = raw.x - last.x;
        let dy = raw.y - last.y;
        // Raster-Schritt auf das Delta (Snap aktiv, nicht per Ctrl unterdrückt).
        const gs = snap.gridSize;
        if (!mods.ctrl && snap.enabled && snap.grid && gs > 0) {
          dx = Math.round(dx / gs) * gs;
          dy = Math.round(dy / gs) * gs;
          if (dx === 0 && dy === 0) {
            edgeFreeLastRef.current = last; // noch kein voller Rasterschritt → warten
            return;
          }
        }
        // Shift = Ortho: das Delta auf die dominante Achse (H/V) zwingen.
        if (mods.shift) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (dx === 0 && dy === 0) return;
        applyEdge(edge.aIndex, edge.bIndex, { x: dx, y: dy });
        setDraft({ preview: [], vertices: [], snap: null });
        return;
      }
      // Cursor zuerst durch die Snap-Engine schicken (Ctrl unterdrückt Snap
      // wie überall sonst, siehe computeSnap). Ein GEOMETRIE-Snap (Endpunkt/
      // Mittelpunkt/Schnittpunkt/…, nicht Raster/Ortho) liefert den gefangenen
      // Punkt, der dann auf die Außennormale projiziert wird — so rastet die
      // Kante an reale Geometrie statt nur ans Raster.
      const snapResult = snapFor(raw, pxPerMeter, mods);
      const isGeometrySnap = !!snapResult && snapResult.kind !== "grid" && snapResult.kind !== "ortho";
      const cursor = isGeometrySnap ? snapResult!.point : raw;
      // Senkrechte Projektion von (Cursor − Grab-Mittelpunkt) auf die Außennormale.
      const rel = sub(cursor, edge.mid);
      let offset = rel.x * edge.normal.x + rel.y * edge.normal.y;
      // Raster-Schritt (Snap) nur, wenn kein Geometrie-Snap gefangen wurde —
      // sonst gewinnt der gefangene Punkt.
      const step = snap.gridSize;
      if (!isGeometrySnap && !mods.ctrl && snap.enabled && snap.grid && step > 0) {
        offset = Math.round(offset / step) * step;
      }
      // INKREMENTELL + Grab-Anker: moveEdge verschiebt additiv, daher nur die
      // Änderung seit dem letzten Event anwenden. Erster Event verankert nur
      // (kein Sprung beim Greifen, da das Dreieck am Mittelpunkt sitzt).
      const prev = edgeDragOffsetRef.current;
      edgeDragOffsetRef.current = offset;
      if (prev === null) return;
      const inc = offset - prev;
      if (inc === 0) return;
      applyEdge(edge.aIndex, edge.bIndex, scale(edge.normal, inc));
      setDraft({ preview: [], vertices: [], snap: isGeometrySnap ? snapResult : null });
    },
    onGripEnd: () => {
      setDraft(null);
      edgeDragOffsetRef.current = null; // Drag beendet → Anker zurücksetzen
      edgeFreeLastRef.current = null; // freien Kanten-Drag-Anker zurücksetzen
      moveCoincidentRef.current = null; // Körper-Koinzidenz-Gruppe verwerfen
      gripDragInfoRef.current = null; // (c) Vertex-Drag-Info verwerfen
      setGripEdit(null); // (c) Feld-Controller schließen
    },
  };

  // Tastatur im Auswahl-Werkzeug: Ctrl/Cmd+A = alles auf der aktiven Ebene
  // wählen; Entf/Backspace = ALLE Selektierten (Wände + 2D-Elemente) löschen.
  useEffect(() => {
    if (activeTool !== "select") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      // Alles auswählen (Wände + Zeichnungen des aktiven Geschosses/der Ebene).
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        const wallIds = project.walls
          .filter((w) => w.floorId === activeLevel.id)
          .map((w) => w.id);
        const drawingIds = project.drawings2d
          .filter((d) => d.levelId === activeLevel.id)
          .map((d) => d.id);
        const ceilingIds = (project.ceilings ?? [])
          .filter((c) => c.floorId === activeLevel.id)
          .map((c) => c.id);
        const stairIds = (project.stairs ?? [])
          .filter((s) => s.floorId === activeLevel.id)
          .map((s) => s.id);
        const roomIds = (project.rooms ?? [])
          .filter((r) => r.floorId === activeLevel.id)
          .map((r) => r.id);
        const extrudedSolidIds = (project.extrudedSolids ?? [])
          .filter((s) => s.levelId === activeLevel.id)
          .map((s) => s.id);
        const columnIds = (project.columns ?? [])
          .filter((c) => c.floorId === activeLevel.id)
          .map((c) => c.id);
        if (
          wallIds.length ||
          drawingIds.length ||
          ceilingIds.length ||
          stairIds.length ||
          roomIds.length ||
          extrudedSolidIds.length ||
          columnIds.length
        ) {
          setSelectedWallIds(wallIds);
          setSelectedDrawingIds(drawingIds);
          setSelectedCeilingIds(ceilingIds);
          setSelectedStairIds(stairIds);
          setSelectedRoomIds(roomIds);
          setSelectedExtrudedSolidIds(extrudedSolidIds);
          setSelectedColumnIds(columnIds);
          e.preventDefault();
        }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (activeTransform) return; // während einer Transformation nicht löschen
      if (
        selectedDrawingIds.length ||
        selectedWallIds.length ||
        selectedCeilingIds.length ||
        selectedOpeningIds.length ||
        selectedStairIds.length ||
        selectedRoomIds.length ||
        selectedExtrudedSolidIds.length ||
        selectedColumnIds.length ||
        selectedRoofIds.length
      ) {
        const dids = new Set(selectedDrawingIds);
        const wids = new Set(selectedWallIds);
        const cids = new Set(selectedCeilingIds);
        const oids = new Set(selectedOpeningIds);
        const stids = new Set(selectedStairIds);
        const rmids = new Set(selectedRoomIds);
        const exids = new Set(selectedExtrudedSolidIds);
        const colids = new Set(selectedColumnIds);
        const rfids = new Set(selectedRoofIds);
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
          doors: p.doors.filter((dr) => !wids.has(dr.hostWallId)),
          // Öffnungen: eigene Auswahl löschen UND alle, deren Host-Wand entfällt.
          openings: (p.openings ?? []).filter(
            (o) => !oids.has(o.id) && !wids.has(o.hostWallId),
          ),
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
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeTool,
    activeTransform,
    selectedDrawingIds,
    selectedWallIds,
    selectedCeilingIds,
    selectedOpeningIds,
    selectedStairIds,
    selectedExtrudedSolidIds,
    selectedColumnIds,
    selectedRoofIds,
    project.walls,
    project.drawings2d,
    project.ceilings,
    project.roofs,
    project.stairs,
    project.extrudedSolids,
    project.columns,
    activeLevel.id,
  ]);

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

  // Ctrl/Cmd+S = Split, Ctrl/Cmd+J = Join der selektierten Drawing2D-Elemente.
  // Join läuft über DENSELBEN Engine-Befehl wie getipptes „join" (§Task C, ein
  // Pfad). Split bleibt vorerst die direkte Aktion (kein Split-Engine-Befehl
  // gefordert). Beide rufen preventDefault (sonst Browser-Speichern/-Lesezeichen).
  // Wände sind ausgenommen (no-op). Tool-unabhängig, solange eine 2D-Auswahl steht.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== "s" && k !== "j") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      const ids = selectedDrawingIds;
      if (ids.length === 0) return; // nur 2D-Auswahl bedient; Wände → no-op
      e.preventDefault();

      if (k === "s") {
        runSplit(ids);
        return;
      }
      // Join: exakt derselbe Befehl wie „join" tippen (Sofort-Befehl, autoRun).
      // Nach dem Verbinden zeigt die alte Auswahl auf ersetzte IDs → aufräumen.
      engine.start("join");
      setSelectedDrawingIds([]);
      setSelectedWallIds([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawingIds, engine]);

  // Ctrl/Cmd+C / Ctrl/Cmd+V = 2D-Zeichenelemente kopieren/einfügen. Kopieren legt
  // die GEWÄHLTEN Drawing2D tief in die Zwischenablage; Einfügen erzeugt Klone mit
  // neuen IDs auf dem AKTIVEN Geschoss (Zeichnungsebene) und wählt sie aus — so
  // wandert z. B. importiertes Mobiliar von einem Geschoss auf ein anderes. Im
  // Textfeld bleibt das native Copy/Paste; ohne 2D-Auswahl kein preventDefault.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "c" && k !== "v") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (k === "c") {
        const ids = new Set(selectedDrawingIds);
        if (ids.size === 0) return; // nur bei 2D-Auswahl (sonst Browser-Copy)
        const picked = project.drawings2d.filter((d) => ids.has(d.id));
        if (picked.length === 0) return;
        e.preventDefault();
        setDrawingClipboard(picked.map((d) => structuredClone(d)));
        return;
      }
      // Einfügen: Klone auf dem aktiven Geschoss, neue IDs, danach ausgewählt.
      if (drawingClipboard.length === 0) return;
      e.preventDefault();
      const stamp = Date.now();
      const pasted: Drawing2D[] = drawingClipboard.map((d, i) => ({
        ...structuredClone(d),
        id: `drawing-${stamp}-${i}`,
        levelId: activeLevelId,
      }));
      importDrawings(pasted);
      setSelectedDrawingIds(pasted.map((p) => p.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawingIds, drawingClipboard, activeLevelId, project.drawings2d]);

  // Ctrl/Cmd+Shift+U/D/I = Boolean Vereinigung/Subtraktion/Schnitt der gewählten
  // geschlossenen Drawing2D. preventDefault (sonst Browser-Aktionen). Braucht ≥2
  // geschlossene Flächen; sonst No-op. (Menü spiegelt diese Aktionen.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== "u" && k !== "d" && k !== "i") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (selectedDrawingIds.length < 2) return;
      e.preventDefault();
      if (k === "u") applyBoolean(unionDrawings);
      else if (k === "d") applyBoolean(differenceDrawings);
      else applyBoolean(intersectionDrawings);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawingIds, project.drawings2d]);

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

  // Transformations-Shortcuts (nur im Auswahl-Werkzeug):
  //  m = Bewegen, s = Spiegeln, d = Drehen (startet auf der Auswahl);
  //  während einer Transformation: u/i/o/p = Modus (move/copy/array/distribute),
  //  Esc = abbrechen. O/P fragen die Kopienanzahl ab.
  useEffect(() => {
    if (activeTool !== "select") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (activeTransform) {
        const k = e.key.toLowerCase();
        if (k === "u") setActiveTransform((t) => (t ? { ...t, copyMode: "move" } : t));
        else if (k === "i") setActiveTransform((t) => (t ? { ...t, copyMode: "copy" } : t));
        else if (k === "o") {
          requestCopyCount("array");
        } else if (k === "p") {
          requestCopyCount("distribute");
        } else if (e.key === "Escape") {
          setActiveTransform(null);
          setDraft(null);
        } else return;
        e.preventDefault();
        return;
      }
      // „q" = Messen (Distanz/Winkel) — braucht KEINE Auswahl, daher vor hasSel.
      if (e.key.toLowerCase() === "q") {
        onRunCommand("measure");
        e.preventDefault();
        return;
      }
      // Transformierbar sind Wände, 2D-Zeichnungen, extrudierte Körper und Stützen
      // (dieselben Arten wie transformSel). Öffnungen/Treppen laufen bewusst NICHT
      // hierüber, sondern über ihre eigenen Bewegpunkte (Grips) — sie sind wand-
      // bzw. geschossgebunden.
      const hasSel =
        selectedWallIds.length > 0 ||
        !!selectedDrawingId ||
        !!selectedExtrudedSolidId ||
        !!selectedColumnId;
      if (!hasSel) return;
      const k = e.key.toLowerCase();
      // Bewegen/Spiegeln/Drehen laufen ALLE über die interaktive Transformation
      // (`activeTransform`) mit den U/I/O/P-Kopiermodi (Bewegen/Kopie/Reihe/
      // Verteilen). Prompt + Optionen + Live-Feld speisen die Command-Line; die
      // Kürzel U/I/O/P wirken dort auch bei fokussiertem Eingabefeld (options.key).
      const op: TransformOp | null =
        k === "m" ? "move" : k === "s" ? "mirror" : k === "d" ? "rotate" : null;
      if (op) {
        setActiveTransform({ op, copyMode: "move", count: 1, points: [] });
        setDraft(null);
        requestAnimationFrame(() => commandLineRef.current?.focus());
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeTool,
    activeTransform,
    selectedWallIds,
    selectedDrawingId,
    selectedExtrudedSolidId,
    selectedColumnId,
    engine,
  ]);

  // ── Projekt-Mutationen (aus dem Store-Slice) ─────────────────────────────
  // Sämtliche immutablen Projekt-Mutationen liegen jetzt in projectSlice. App
  // liest sie als (referenzstabile) Store-Actions und reicht sie unverändert an
  // Panels/Menüs/Editoren weiter.
  const toggleLevelVisible = useStore((s) => s.toggleLevelVisible);
  const toggleCategoryVisible = useStore((s) => s.toggleCategoryVisible);
  const addFloor = useStore((s) => s.addFloor);
  const addDrawing = useStore((s) => s.addDrawing);
  const addSection = useStore((s) => s.addSection);
  const addElevation = useStore((s) => s.addElevation);
  const addDrawingLevel = useStore((s) => s.addDrawingLevel);
  const importDrawings = useStore((s) => s.importDrawings);
  const addCategory = useStore((s) => s.addCategory);
  const patchCategory = useStore((s) => s.patchCategory);
  const addSubCategory = useStore((s) => s.addSubCategory);
  const duplicateCategory = useStore((s) => s.duplicateCategory);
  const deleteCategory = useStore((s) => s.deleteCategory);
  const assignWallCategory = useStore((s) => s.assignWallCategory);
  const snapshotLayerVisibility = useStore((s) => s.snapshotLayerVisibility);
  const applyLayerVisibility = useStore((s) => s.applyLayerVisibility);
  const snapshotDrawingVisibility = useStore((s) => s.snapshotDrawingVisibility);
  const applyDrawingVisibility = useStore((s) => s.applyDrawingVisibility);
  const patchLevel = useStore((s) => s.patchLevel);
  const duplicateLevel = useStore((s) => s.duplicateLevel);
  const deleteLevel = useStore((s) => s.deleteLevel);
  const patchComponent = useStore((s) => s.patchComponent);
  const addComponent = useStore((s) => s.addComponent);
  const deleteComponent = useStore((s) => s.deleteComponent);
  const patchHatch = useStore((s) => s.patchHatch);
  const addHatch = useStore((s) => s.addHatch);
  const deleteHatch = useStore((s) => s.deleteHatch);
  const patchLineStyle = useStore((s) => s.patchLineStyle);
  const addLineStyle = useStore((s) => s.addLineStyle);
  const deleteLineStyle = useStore((s) => s.deleteLineStyle);
  // Wandstile: immutable Patch eines Wandtyps (z. B. Schichtfugen-Stile). Kein
  // eigener Store-Slice nötig — läuft direkt über setProject wie die übrigen
  // Ressourcen-Mutationen.
  const patchWallType = (id: string, patch: Partial<WallType>) =>
    setProject((p) => ({
      ...p,
      wallTypes: p.wallTypes.map((wt) => (wt.id === id ? { ...wt, ...patch } : wt)),
    }));
  // Grafische Override-Regeln: ersetzt die ganze Regelliste (Reihenfolge =
  // Priorität, oben gewinnt). Läuft wie die übrigen Ressourcen-Mutationen
  // direkt über setProject — persistiert damit automatisch im Projekt-JSON.
  const setOverrideRules = (rules: OverrideRule[]) =>
    setProject((p) => ({ ...p, overrideRules: rules }));
  // Deckenstile: immutable Patch eines Deckentyps — analog `patchWallType`.
  const patchCeilingType = (id: string, patch: Partial<CeilingType>) =>
    setProject((p) => ({
      ...p,
      ceilingTypes: (p.ceilingTypes ?? []).map((ct) =>
        ct.id === id ? { ...ct, ...patch } : ct,
      ),
    }));
  // Neuen Wandtyp anlegen: eine Default-Schicht (erstes Bauteil, 200 mm).
  const addWallType = () =>
    setProject((p) => {
      const componentId = p.components[0]?.id ?? "";
      const wallType: WallType = {
        id: `wt-${Date.now()}`,
        name: t("default.wallTypeName"),
        layers: [{ componentId, thickness: 0.2 }],
      };
      return { ...p, wallTypes: [...p.wallTypes, wallType] };
    });
  // Wandtyp löschen — geschützt, solange ihn eine Wand verwendet.
  const deleteWallType = (id: string) =>
    setProject((p) => {
      const used = p.walls.some((w) => w.wallTypeId === id);
      if (used) {
        const name = p.wallTypes.find((wt) => wt.id === id)?.name ?? id;
        notify(t("alert.wallTypeInUse", { name }), "warning");
        return p;
      }
      return { ...p, wallTypes: p.wallTypes.filter((wt) => wt.id !== id) };
    });
  // Neuen Deckentyp anlegen — analog `addWallType` (150 mm Default).
  const addCeilingType = () =>
    setProject((p) => {
      const componentId = p.components[0]?.id ?? "";
      const ceilingType: CeilingType = {
        id: `ct-${Date.now()}`,
        name: t("default.ceilingTypeName"),
        layers: [{ componentId, thickness: 0.15 }],
      };
      return { ...p, ceilingTypes: [...(p.ceilingTypes ?? []), ceilingType] };
    });
  // Deckentyp löschen — geschützt, solange ihn eine Decke verwendet.
  const deleteCeilingType = (id: string) =>
    setProject((p) => {
      const used = (p.ceilings ?? []).some((c) => c.ceilingTypeId === id);
      if (used) {
        const name = (p.ceilingTypes ?? []).find((ct) => ct.id === id)?.name ?? id;
        notify(t("alert.ceilingTypeInUse", { name }), "warning");
        return p;
      }
      return {
        ...p,
        ceilingTypes: (p.ceilingTypes ?? []).filter((ct) => ct.id !== id),
      };
    });
  // ── Bauteil-Typen: Tür / Fenster / Treppe (Bibliothek) ────────────────────
  // Anlegen/Patchen/Löschen analog Wand-/Deckentyp — direkt über setProject
  // (kein eigener Slice). Löschen ist geschützt, solange ein Element den Typ
  // per `typeId` referenziert. Defaults orientieren sich an den Element-Inline-
  // Werten (Tür 0.9×2.0, Fenster 1.2×1.4 Brüstung 0.9).
  const addDoorType = () =>
    setProject((p) => {
      const dt: DoorType = {
        id: `dt-${Date.now()}`,
        name: t("default.doorTypeName"),
        kind: "dreh",
        leafCount: 1,
        leafStyle: "glatt",
        frameThickness: 0.05,
        defaultWidth: 0.9,
        defaultHeight: 2.0,
      };
      return { ...p, doorTypes: [...(p.doorTypes ?? []), dt] };
    });
  const patchDoorType = (id: string, patch: Partial<DoorType>) =>
    setProject((p) => ({
      ...p,
      doorTypes: (p.doorTypes ?? []).map((dt) =>
        dt.id === id ? { ...dt, ...patch } : dt,
      ),
    }));
  const deleteDoorType = (id: string) =>
    setProject((p) => {
      const used = (p.openings ?? []).some((o) => o.typeId === id);
      if (used) {
        const name = (p.doorTypes ?? []).find((dt) => dt.id === id)?.name ?? id;
        notify(t("alert.doorTypeInUse", { name }), "warning");
        return p;
      }
      return { ...p, doorTypes: (p.doorTypes ?? []).filter((dt) => dt.id !== id) };
    });
  const addWindowType = () =>
    setProject((p) => {
      const wt: WindowType = {
        id: `ft-${Date.now()}`,
        name: t("default.windowTypeName"),
        kind: "drehkipp",
        wingCount: 1,
        glazing: "zweifach",
        frameThickness: 0.06,
        defaultSillHeight: 0.9,
        defaultWidth: 1.2,
        defaultHeight: 1.4,
      };
      return { ...p, windowTypes: [...(p.windowTypes ?? []), wt] };
    });
  const patchWindowType = (id: string, patch: Partial<WindowType>) =>
    setProject((p) => ({
      ...p,
      windowTypes: (p.windowTypes ?? []).map((wt) =>
        wt.id === id ? { ...wt, ...patch } : wt,
      ),
    }));
  const deleteWindowType = (id: string) =>
    setProject((p) => {
      const used = (p.openings ?? []).some((o) => o.typeId === id);
      if (used) {
        const name = (p.windowTypes ?? []).find((wt) => wt.id === id)?.name ?? id;
        notify(t("alert.windowTypeInUse", { name }), "warning");
        return p;
      }
      return {
        ...p,
        windowTypes: (p.windowTypes ?? []).filter((wt) => wt.id !== id),
      };
    });
  const addStairType = () =>
    setProject((p) => {
      const st: StairType = {
        id: `st-${Date.now()}`,
        name: t("default.stairTypeName"),
        structure: "massiv",
        closedRisers: true,
        treadThickness: 0.04,
        nosing: 0.03,
        railing: "keine",
        defaultWidth: 1.0,
      };
      return { ...p, stairTypes: [...(p.stairTypes ?? []), st] };
    });
  const patchStairType = (id: string, patch: Partial<StairType>) =>
    setProject((p) => ({
      ...p,
      stairTypes: (p.stairTypes ?? []).map((st) =>
        st.id === id ? { ...st, ...patch } : st,
      ),
    }));
  const deleteStairType = (id: string) =>
    setProject((p) => {
      const used = (p.stairs ?? []).some((s) => s.typeId === id);
      if (used) {
        const name = (p.stairTypes ?? []).find((st) => st.id === id)?.name ?? id;
        notify(t("alert.stairTypeInUse", { name }), "warning");
        return p;
      }
      return { ...p, stairTypes: (p.stairTypes ?? []).filter((st) => st.id !== id) };
    });
  const importLineStyles = useStore((s) => s.importLineStyles);
  const importHatches = useStore((s) => s.importHatches);
  // Site-/Kontext-Schicht (siteSlice): Import/Entfernen/Gelände.
  const addContextObjects = useStore((s) => s.addContextObjects);
  // Wie addContextObjects, aber passt die Plan-Ansicht danach auf die Bounding-
  // Box der NEU importierten Objekte ein (Auto-Zoom auf Import, ROADMAP §11) —
  // sonst muss man nach Standort-/Geo-Import manuell zur Geometrie suchen.
  const addContextObjectsAndFit = (objs: ContextObject[]) => {
    addContextObjects(objs);
    const pts = contextObjectsBounds(objs);
    if (pts) planViewRef.current?.fitBounds(pts);
  };
  const removeContextObject = useStore((s) => s.removeContextObject);
  const generateTerrain = useStore((s) => s.generateTerrain);
  const moveGripOf = useStore((s) => s.moveGripOf);
  const moveElementByOf = useStore((s) => s.moveElementByOf);
  const moveEdgeOf = useStore((s) => s.moveEdgeOf);
  const commitTransformOn = useStore((s) => s.commitTransformOn);
  const setElementColor = useStore((s) => s.setElementColor);
  const setElementWeight = useStore((s) => s.setElementWeight);
  const setElementFill = useStore((s) => s.setElementFill);
  const setElementFillColor = useStore((s) => s.setElementFillColor);
  const setElementForeground = useStore((s) => s.setElementForeground);
  const setElementBackground = useStore((s) => s.setElementBackground);
  const updateDrawing2D = useStore((s) => s.updateDrawing2D);
  const reorderDrawings = useStore((s) => s.reorderDrawings);
  const resizeElement = useStore((s) => s.resizeElement);
  const updateWall = useStore((s) => s.updateWall);
  const setWallThickness = useStore((s) => s.setWallThickness);
  const updateOpening = useStore((s) => s.updateOpening);
  const moveCeilingGrip = useStore((s) => s.moveCeilingGrip);
  const moveCeilingBy = useStore((s) => s.moveCeilingBy);
  const moveCeilingEdge = useStore((s) => s.moveCeilingEdge);
  const updateCeiling = useStore((s) => s.updateCeiling);
  const setCeilingThickness = useStore((s) => s.setCeilingThickness);
  const updateStair = useStore((s) => s.updateStair);
  const moveStairBy = useStore((s) => s.moveStairBy);
  const updateRoom = useStore((s) => s.updateRoom);
  const moveRoomBy = useStore((s) => s.moveRoomBy);
  const moveRoomGrip = useStore((s) => s.moveRoomGrip);
  const moveRoomEdge = useStore((s) => s.moveRoomEdge);
  const moveRoomStamp = useStore((s) => s.moveRoomStamp);
  const setRoomStampDoc = useStore((s) => s.setRoomStampDoc);
  const setRoomStamp = useStore((s) => s.setRoomStamp);

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
        return {
          doc: docFromText(g.text, g.marks ?? {}),
          range: null,
          apply: (doc: RichTextDoc) => {
            const runMarks = doc.paragraphs.flatMap((p) => p.runs)[0]?.marks ?? {};
            const marks = { ...runMarks };
            delete marks.sizePt; // Grösse folgt der Modell-Höhe, nicht dem pt-Wert.
            updateDrawing2D(d.id, { geom: { ...g, text: plainText(doc), marks } });
          },
        };
      }
    }
    return null;
  }, [selectedRoom, setRoomStampDoc, selectedDrawingId, project.drawings2d, updateDrawing2D]);

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
  // Ein 3D-Vertex-Griff wurde gezogen. `target` benennt das konkrete Element
  // (Wand-ID ODER Drawing-ID), `index` den Vertex. Liefert den effektiv
  // angewandten (gesnappten) Punkt zurück — der 3D-Viewport nutzt ihn, um
  // koinzidente Endpunkte anderer gewählter Elemente mitzuführen und den
  // Snap-Marker zu zeigen. `snapped=false` (für mitgeführte Geschwister) wendet
  // den Punkt direkt an, ohne erneut zu snappen.
  const onEdit3dVertex = (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    index: number,
    model: Vec2,
    excludeWallIds?: Set<string>,
    excludeDrawingIds?: Set<string>,
  ): Vec2 => {
    let pt = model;
    if (excludeWallIds || excludeDrawingIds) {
      const snapResult = snapFor3dVertex(
        model,
        excludeWallIds ?? new Set(),
        excludeDrawingIds ?? new Set(),
      );
      pt = snapResult?.point ?? model;
    }
    if (target.roofId) moveRoofGrip(target.roofId, index, pt);
    else if (target.ceilingId) moveCeilingGrip(target.ceilingId, index, pt);
    else moveGripOf(target.drawingId ?? null, target.wallId ?? null, index, pt);
    return pt;
  };
  const onEdit3dBody = (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    delta: Vec2,
  ) => {
    if (target.roofId) moveRoofBy(target.roofId, delta);
    else if (target.ceilingId) moveCeilingBy(target.ceilingId, delta);
    else moveElementByOf(target.drawingId ?? null, target.wallId ?? null, delta);
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
    updateRoof(roofId, { pitchDeg: Math.max(1, Math.min(85, newPitch)) });
  };
  const onEdit3dEdge = (ceilingId: string, aIndex: number, bIndex: number, delta: Vec2) => {
    moveCeilingEdge(ceilingId, aIndex, bIndex, delta);
  };
  const onEdit3dWallTop = (wallId: string, topZ: number) => {
    updateWall(wallId, { top: { mode: "custom", z: topZ } });
  };
  const onEdit3dEnd = () => {
    setDraft(null);
  };

  // ── Selektions-Attribut-Kontrakt (Attributes-/Object-Info-Paletten) ───────
  // Normalisierte, effektiv aufgelöste Sicht auf das erste selektierte Element.
  const selection = useMemo(
    () =>
      deriveSelection(
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
      ),
    [
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
    ],
  );

  // ── DXF/DWG-Import (Dialog) ───────────────────────────────────────────────
  // Eine Datei (Button ODER Drop) öffnet den modalen Import-Dialog. DXF wird als
  // Text geparst, DWG als ArrayBuffer über LibreDWG-WASM (lazy, asynchron); beide
  // münden in dasselbe {meshes, contours}-Format und denselben Dialog-Fluss.
  // Parse-Fehler werden ruhig abgefangen: DWG fällt auf den ODA-Hinweis zurück.
  const openImportForFile = (file: File) => {
    const isDwg = /\.dwg$/i.test(file.name);
    if (isDwg) {
      // Async-Zustand: Dialog öffnet sofort und zeigt „DWG wird gelesen …",
      // während WASM lädt/parst. Danach echte Zusammenfassung ODER ODA-Hinweis.
      setImportState({
        fileName: file.name,
        isDwg: true,
        parsed: null,
        loading: true,
      });
      const r = new FileReader();
      r.onload = () => {
        const buf = r.result;
        if (!(buf instanceof ArrayBuffer)) {
          setImportState({
            fileName: file.name,
            isDwg: true,
            parsed: null,
            loading: false,
          });
          return;
        }
        // Dynamisch importieren, damit LibreDWG-WASM nicht im Initial-Bundle ist.
        import("./io/dwgParser")
          .then(({ parseDwg }) => parseDwg(buf))
          .then((parsed) => {
            setImportState({
              fileName: file.name,
              isDwg: false,
              parsed,
              loading: false,
            });
          })
          .catch((err) => {
            console.error("DWG-Import fehlgeschlagen:", err);
            // Fallback: weiterhin DWG-Modus → Dialog zeigt den ODA-Hinweis.
            setImportState({
              fileName: file.name,
              isDwg: true,
              parsed: null,
              loading: false,
            });
          });
      };
      r.readAsArrayBuffer(file);
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      let parsed: DxfImportResult | null = null;
      try {
        parsed = parseDxf(String(r.result ?? ""));
      } catch (err) {
        console.error("DXF-Import fehlgeschlagen:", err);
        parsed = { meshes: [], contours: [] };
      }
      setImportState({ fileName: file.name, isDwg: false, parsed });
    };
    r.readAsText(file);
  };

  // Projekt als Datei speichern/laden (Datei-Burger-Menü, TopBar/AppMenu).
  // Reines JSON des ProjectSlice-Zustands. Eigene Endung „.obp" (openbureau
  // project) statt generischem „.json" — unter Tauri über den nativen
  // Speichern-/Öffnen-Dialog mit passendem Datei-Filter (saveProjectFile/
  // openProjectFileNative in io/projectFile.ts), im Browser Blob-Download wie
  // bisher. Laden parst die Datei und ersetzt das Projekt — nur ein grobes
  // Shape-Sanity-Check (walls/layers als Array), damit ein fremdes/kaputtes
  // JSON nicht die App zerlegt. Alte „.json"-Projekte bleiben ladbar (Filter
  // erlaubt beide Endungen).
  const onSaveProject = () => {
    const json = JSON.stringify(project, null, 2);
    void saveProjectFile(json, project.name);
  };
  // Gibt den Lock der zuletzt geöffneten Projektdatei frei (falls wir ihn
  // halten) und vergisst den Pfad — vor dem Wechsel auf ein anderes Projekt.
  const releaseCurrentProjectLock = () => {
    if (openedProjectPathRef.current && projectLockOwnedRef.current) {
      void releaseProjectLock(openedProjectPathRef.current);
    }
    openedProjectPathRef.current = null;
    projectLockOwnedRef.current = false;
  };
  // Übernimmt ein per Pfad geöffnetes Projekt (Tauri-Fluss): parst, prüft grob
  // die Form, gibt einen evtl. vorher gehaltenen Lock frei und merkt sich Pfad
  // + ob WIR den Schreib-Lock für die neue Datei halten.
  const applyOpenedProjectFile = (path: string, content: string, lockOwned: boolean) => {
    try {
      const parsed = JSON.parse(content) as Partial<Project>;
      if (!Array.isArray(parsed.walls) || !Array.isArray(parsed.layers)) {
        console.warn("Projekt-Datei hat kein gültiges Projekt-Format (walls/layers fehlen).");
        return;
      }
      releaseCurrentProjectLock();
      setProject(parsed as Project);
      openedProjectPathRef.current = path;
      projectLockOwnedRef.current = lockOwned;
    } catch (err) {
      console.error("Projekt-Import fehlgeschlagen:", err);
    }
  };
  // Öffnen unter Tauri: nativer Dialog (echter Pfad) → Lock versuchen. Klappt
  // er → Projekt übernehmen. Schon gesperrt → Konflikt-Dialog (kein
  // window.confirm!) mit „Schreibgeschützt öffnen"/„Trotzdem erzwingen"/
  // „Abbrechen". Beide „öffnen"-Optionen übernehmen das Projekt ohne eigenen
  // Lock (die andere Instanz hält ihn) — „erzwingen" bewusst mit Warn-Hinweis
  // im Dialog, „schreibgeschützt" als sichere Standardwahl.
  const openProjectViaNativeDialog = async () => {
    let opened: Awaited<ReturnType<typeof openProjectFileNative>>;
    try {
      opened = await openProjectFileNative();
    } catch (err) {
      console.error(t("file.openFailed"), err);
      return;
    }
    if (!opened) return; // Nutzer hat den Öffnen-Dialog abgebrochen
    const lock = await acquireProjectLock(opened.path);
    if (lock.ok) {
      applyOpenedProjectFile(opened.path, opened.content, true);
    } else {
      setLockConflict({ path: opened.path, content: opened.content, info: lock.info });
    }
  };
  // Datei speichern: unter Tauri nativer „Speichern unter"-Dialog (Ordner + Name),
  // im Browser Blob-Download-Fallback — die gesamte Logik (inkl. WKWebView-
  // Härtung: octet-stream-MIME + verzögertes revoke) steckt in saveTextFile.
  const downloadTextFile = (
    content: string,
    filename: string,
    mime = "application/octet-stream",
  ) => {
    void saveTextFile(content, filename, mime);
  };
  const projectFileName = () => project.name || "modell";
  // Führt den gewählten Direkt-Export (CSV/IFC/OBJ/STL) mit dem im Dialog
  // gewählten Dateinamen aus. Erzeugung aus dem jeweiligen reinen Kern, Download
  // über den robusten Helfer.
  const runExport = (format: ExportSaveFormat, filename: string) => {
    switch (format) {
      case "csv":
        downloadTextFile("﻿" + exportScheduleCsv(project), filename, "text/csv;charset=utf-8;");
        break;
      case "ifc":
        downloadTextFile(exportIfcSpf(project), filename);
        break;
      case "obj":
        downloadTextFile(exportObj(project), filename);
        break;
      case "stl":
        downloadTextFile(exportStl(project), filename);
        break;
    }
  };
  // Schnellexport aus dem Topbar-Menü öffnet den Format-/Dateiname-Dialog
  // (vorausgewähltes Format). PDF/DXF haben eigene Options-Dialoge.
  const onExportSchedule = () => setExportSaveFormat("csv");
  const onExportIfc = () => setExportSaveFormat("ifc");
  const onExportObj = () => setExportSaveFormat("obj");
  const onExportStl = () => setExportSaveFormat("stl");
  // Unter Tauri: nativer Öffnen-Dialog (echter Pfad → Lock möglich). Im
  // Browser: verstecktes <input type=file> wie bisher (kein echter Pfad, also
  // ohne Lock — File-API im Browser liefert keinen Dateisystempfad).
  const onOpenProject = () => {
    if (isTauriRuntime()) {
      void openProjectViaNativeDialog();
    } else {
      projectFileInputRef.current?.click();
    }
  };
  const onProjectFileChosen = (file: File) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(String(r.result ?? "")) as Partial<Project>;
        if (!Array.isArray(parsed.walls) || !Array.isArray(parsed.layers)) {
          console.warn("Projekt-Datei hat kein gültiges Projekt-Format (walls/layers fehlen).");
          return;
        }
        // Browser-Pfad hat keinen echten Dateipfad → kein Lock für die neue
        // Datei, aber ein evtl. vorher (unter Tauri) gehaltener Lock wird frei.
        releaseCurrentProjectLock();
        setProject(parsed as Project);
      } catch (err) {
        console.error("Projekt-Import fehlgeschlagen:", err);
      }
    };
    r.readAsText(file);
  };

  // Bestätigte Import-Entscheidung ausführen: ggf. neue Zeichnung anlegen, die
  // 2D-Konturen als Drawing2D anhängen, optional die Meshes als Kontext
  // übernehmen. Reihenfolge: erst Ebene (echte ID), dann Drawings/Kontext.
  const runImport = (decision: ImportDecision) => {
    const levelId =
      decision.target.kind === "new"
        ? addDrawingLevel(decision.target.name)
        : decision.target.levelId;
    let drawings = buildDrawings(
      decision,
      levelId,
      project,
      activeCategoryCode,
    );
    // Platzierung „viewCenter": den Gesamt-Umriss so verschieben, dass seine
    // Mitte auf die Mitte des aktuellen Ausschnitts fällt (sonst bleibt alles an
    // den DXF-Koordinaten relativ zum Nullpunkt).
    if (decision.placement === "viewCenter" && drawings.length) {
      const center = planViewRef.current?.viewCenterModel();
      const bb = drawingsBBox(drawings);
      if (center && bb) {
        const dx = center.x - (bb.minX + bb.maxX) / 2;
        const dy = center.y - (bb.minY + bb.maxY) / 2;
        drawings = drawings.map((d) => translateDrawing(d, dx, dy));
      }
    }
    if (drawings.length) importDrawings(drawings);
    if (decision.importMeshes && decision.parsed.meshes.length) {
      addContextObjects(decision.parsed.meshes);
    }
    // Auf die Ziel-Ebene wechseln, damit die importierte Geometrie sichtbar ist.
    setActiveLevelId(levelId);
    setImportState(null);
  };

  // ── Host-Context für die Panels ───────────────────────────────────────────
  // Alles außer dem (dock-spezifischen) Darstellungsmodus ist gemeinsam; den
  // Modus hängt jedes Dock weiter unten passend zu seinem aktiven Tab an.
  const baseHost = useMemo(() => {
    const value: Omit<PanelHostValue, "displayMode"> = {
      project,
      activeLevelId,
      activeTool,
      onSelectTool,
      // Werkzeuge auch in der Perspektive: der Cursor wird per Raycast auf die
      // Geschoss-Arbeitsebene (OKFF) projiziert und über onWorkplanePoint in
      // dieselbe Engine wie im Grundriss gespeist (Viewport3D).
      toolsEnabled: activeLevel.kind === "floor",
      activeWallTypeId,
      onActiveWallTypeId: setActiveWallTypeId,
      snap,
      onSnapChange: setSnap,
      onSelectLevel: setActiveLevelId,
      onToggleLevel: toggleLevelVisible,
      onAddFloor: addFloor,
      onAddDrawing: addDrawing,
      onAddSection: addSection,
      onAddElevation: addElevation,
      onLevelContextMenu: (id, x, y) =>
        setMenu({ kind: "level", id, x, y }),
      activeCategoryCode,
      onSelectCategory: setActiveCategoryCode,
      onToggleCategory: toggleCategoryVisible,
      onAddCategory: addCategory,
      onLayerContextMenu: (code, x, y) =>
        setMenu({ kind: "layer", code, x, y }),
      onPatchComponent: patchComponent,
      onAddComponent: addComponent,
      onDeleteComponent: deleteComponent,
      onPatchHatch: patchHatch,
      onAddHatch: addHatch,
      onDeleteHatch: deleteHatch,
      onPatchLineStyle: patchLineStyle,
      onAddLineStyle: addLineStyle,
      onDeleteLineStyle: deleteLineStyle,
      onPatchWallType: patchWallType,
      onAddWallType: addWallType,
      onDeleteWallType: deleteWallType,
      onPatchCeilingType: patchCeilingType,
      onAddCeilingType: addCeilingType,
      onDeleteCeilingType: deleteCeilingType,
      onImportLineStyles: importLineStyles,
      onImportHatches: importHatches,
      selection,
      // Platzhalter — der LIVE-Wert wird in `hostWithMode` je Render injiziert
      // (nicht hier, weil `draft` bewusst kein Dep dieses Memos ist, s. dort).
      measurement: null,
      onSetSelectionColor: (color) => {
        if (!selection) return;
        if (selection.kind === "wall" || selection.kind === "drawing2d")
          setElementColor(selection.kind, selection.id, color);
        else if (selection.kind === "ceiling")
          updateCeiling(selection.id, { color });
        else if (selection.kind === "opening")
          updateOpening(selection.id, { color });
        else if (selection.kind === "stair")
          updateStair(selection.id, { color });
        else if (selection.kind === "room")
          updateRoom(selection.id, { color });
      },
      onSetSelectionWeight: (weightMm) => {
        // Strichstärke-Override: Wand/Decke (`strokeWeight`) oder Drawing2D
        // (`weightMm`, Alt-Feldname bleibt).
        if (selection?.kind === "wall") updateWall(selection.id, { strokeWeight: weightMm });
        else if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { strokeWeight: weightMm });
        else if (selection?.kind === "drawing2d")
          setElementWeight(selection.id, weightMm);
      },
      onSetSelectionFill: (hatchId) => {
        // Schraffur-Override: Wand, Decke oder Drawing2D (geschlossene Formen).
        // `null` löscht das Feld (→ „Nach System"/Quelle).
        if (selection?.kind === "wall")
          updateWall(selection.id, { hatchId: hatchId ?? undefined });
        else if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { hatchId: hatchId ?? undefined });
        else if (selection?.kind === "drawing2d")
          setElementFill(selection.id, hatchId);
      },
      onSetSelectionLineStyle: (lineStyleId) => {
        // Nur Drawing2D trägt einen Linienstil (Wand/Decke/etc. nicht).
        if (selection?.kind === "drawing2d")
          updateDrawing2D(selection.id, { lineStyleId });
      },
      onSetSelectionFillColor: (color) => {
        // Vollton-Füllfarbe nur bei Drawing2D (geschlossene Formen).
        if (selection?.kind === "drawing2d")
          setElementFillColor(selection.id, color);
      },
      onSetSelectionForeground: (color) => {
        // Vordergrund-Override: Wand, Decke oder Drawing2D.
        if (
          selection?.kind === "wall" ||
          selection?.kind === "ceiling" ||
          selection?.kind === "drawing2d"
        )
          setElementForeground(selection.kind, selection.id, color);
      },
      onSetSelectionBackground: (color) => {
        // Hintergrund-Override: Wand, Decke oder Drawing2D.
        if (
          selection?.kind === "wall" ||
          selection?.kind === "ceiling" ||
          selection?.kind === "drawing2d"
        )
          setElementBackground(selection.kind, selection.id, color);
      },
      // ── By-Layer/By-Object-Quellen (Vordergrund/Hintergrund/Strichstärke/
      // Schraffur): "layer" erzwingt die Ebene, "object" erbt vom Bauteil —
      // beide löschen dabei den expliziten Wert (siehe Modell-Kommentar
      // `AttributeSource`); „eigener Wert" läuft weiterhin über die
      // onSetSelection{Foreground,Background,Weight,Fill}-Setter oben.
      onSetSelectionForegroundSource: (source) => {
        if (!selection) return;
        const patch = {
          foregroundSource: source === "layer" ? ("layer" as const) : undefined,
          foreground: undefined,
        };
        if (selection.kind === "wall") updateWall(selection.id, patch);
        else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
        else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
      },
      onSetSelectionBackgroundSource: (source) => {
        if (!selection) return;
        const patch = {
          backgroundSource: source === "layer" ? ("layer" as const) : undefined,
          background: undefined,
        };
        if (selection.kind === "wall") updateWall(selection.id, patch);
        else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
        else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
      },
      onSetSelectionStrokeWeightSource: (source) => {
        if (!selection) return;
        const strokeWeightSource = source === "layer" ? ("layer" as const) : undefined;
        if (selection.kind === "wall")
          updateWall(selection.id, { strokeWeightSource, strokeWeight: undefined });
        else if (selection.kind === "ceiling")
          updateCeiling(selection.id, { strokeWeightSource, strokeWeight: undefined });
        else if (selection.kind === "drawing2d")
          updateDrawing2D(selection.id, { strokeWeightSource, weightMm: undefined });
      },
      onSetSelectionHatchSource: (source) => {
        if (!selection) return;
        const hatchSource = source === "layer" ? ("layer" as const) : undefined;
        if (selection.kind === "wall")
          updateWall(selection.id, { hatchSource, hatchId: undefined });
        else if (selection.kind === "ceiling")
          updateCeiling(selection.id, { hatchSource, hatchId: undefined });
        else if (selection.kind === "drawing2d")
          updateDrawing2D(selection.id, { hatchSource, hatchId: undefined });
      },
      onResizeSelection: (w, h, anchor) => {
        if (selection?.kind === "wall" || selection?.kind === "drawing2d")
          resizeElement(selection.kind, selection.id, w, h, anchor);
      },
      onMoveSelectionBy: (dx, dy) => {
        if (!selection) return;
        if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) return;
        const sel2 = singleTransformSel(selection.kind, selection.id);
        if (!sel2) return;
        commitTransformOn(sel2, "move", [{ x: 0, y: 0 }, { x: dx, y: dy }], "move", 1);
      },
      onRotateSelectionAround: (cx, cy, deg) => {
        if (!selection) return;
        if (!isFinite(deg) || deg === 0) return;
        const sel2 = singleTransformSel(selection.kind, selection.id);
        if (!sel2) return;
        const rad = (deg * Math.PI) / 180;
        commitTransformOn(
          sel2,
          "rotate",
          [
            { x: cx, y: cy },
            { x: cx + 1, y: cy },
            { x: cx + Math.cos(rad), y: cy + Math.sin(rad) },
          ],
          "move",
          1,
        );
      },
      onSetDrawingLineLength: (length) => {
        if (selection?.kind !== "drawing2d" || !isFinite(length) || length <= 0) return;
        const d = project.drawings2d.find((x) => x.id === selection.id);
        if (!d || d.geom.shape !== "line") return;
        const { a, b } = d.geom;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-9) return;
        const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        updateDrawing2D(selection.id, {
          geom: { ...d.geom, b: { x: a.x + ux * length, y: a.y + uy * length } },
        });
      },
      onSetDrawingCircleRadius: (radius) => {
        if (selection?.kind !== "drawing2d" || !isFinite(radius) || radius <= 0) return;
        const d = project.drawings2d.find((x) => x.id === selection.id);
        if (!d || d.geom.shape !== "circle") return;
        updateDrawing2D(selection.id, { geom: { ...d.geom, r: radius } });
      },
      // ── Wand-Attribute (nur bei selektierter Wand) ─────────────────────────
      onSetWallReferenceLine: (ref) => {
        if (selection?.kind === "wall")
          // Benannte Linie gewählt ⇒ freien Fugen-Versatz löschen (er übersteuert sonst).
          updateWall(selection.id, { referenceLine: ref, referenceOffset: undefined });
      },
      onSetWallReferenceOffset: (offset) => {
        if (selection?.kind === "wall")
          updateWall(selection.id, { referenceOffset: offset ?? undefined });
      },
      onSetWallSliceTermination: (termination) => {
        if (selection?.kind === "wall")
          // "both" ist der Default ⇒ als undefined speichern (Alt-Projekt-Parität).
          updateWall(selection.id, {
            sliceTermination: termination === "both" ? undefined : termination,
          });
      },
      onSetWallType: (wallTypeId) => {
        if (selection?.kind === "wall")
          updateWall(selection.id, { wallTypeId });
      },
      onSetWallThickness: (thickness) => {
        if (selection?.kind === "wall")
          setWallThickness(selection.id, thickness);
      },
      onSetWallBottom: (anchor) => {
        if (selection?.kind === "wall")
          updateWall(selection.id, { bottom: anchor ?? undefined });
      },
      onSetWallTop: (anchor) => {
        if (selection?.kind === "wall")
          updateWall(selection.id, { top: anchor ?? undefined });
      },
      // ── Decken-Attribute (nur bei selektierter Decke) ──────────────────────
      onSetCeilingType: (ceilingTypeId) => {
        if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { ceilingTypeId, thickness: undefined });
      },
      onSetCeilingThickness: (thickness) => {
        if (selection?.kind === "ceiling")
          setCeilingThickness(selection.id, thickness);
      },
      onSetCeilingTop: (anchor) => {
        if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { top: anchor ?? undefined });
      },
      onSetCeilingBottom: (anchor) => {
        if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { bottom: anchor ?? undefined });
      },
      // ── Öffnungs-Attribute (nur bei selektierter Öffnung) ──────────────────
      onSetOpeningKind: (kind) => {
        if (selection?.kind === "opening")
          updateOpening(
            selection.id,
            kind === "door"
              ? { kind, sillHeight: 0, hinge: "start", swing: "left", openingDir: "in", swingAngle: 90 }
              : { kind },
          );
      },
      onSetOpeningWidth: (width) => {
        if (selection?.kind === "opening" && width > 0)
          updateOpening(selection.id, { width });
      },
      onSetOpeningHeight: (height) => {
        if (selection?.kind === "opening" && height > 0)
          updateOpening(selection.id, { height });
      },
      onSetOpeningSill: (sillHeight) => {
        if (selection?.kind === "opening" && sillHeight >= 0)
          updateOpening(selection.id, { sillHeight });
      },
      onSetOpeningPosition: (position) => {
        if (selection?.kind === "opening" && position >= 0)
          updateOpening(selection.id, { position });
      },
      onSetOpeningSwingAngle: (swingAngle) => {
        if (selection?.kind === "opening" && swingAngle > 0)
          updateOpening(selection.id, { swingAngle });
      },
      onSetOpeningHinge: (hinge) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { hinge });
      },
      onSetOpeningSwing: (swing) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { swing });
      },
      onSetOpeningDir: (openingDir) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { openingDir });
      },
      onSetOpeningWingCount: (wingCount) => {
        if (selection?.kind === "opening")
          updateOpening(selection.id, { wingCount: Math.max(1, Math.min(4, Math.round(wingCount))) });
      },
      onSetOpeningDoorType: (doorType) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { doorType });
      },
      onSetOpeningLintelLines: (lintelLines) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { lintelLines });
      },
      // Typ-Zuweisung (Bibliothek): Tür-/Fenstertyp per typeId; leerer String löst
      // die Zuweisung wieder (Inline-Verhalten).
      onSetOpeningType: (typeId) => {
        if (selection?.kind === "opening")
          updateOpening(selection.id, { typeId: typeId || undefined });
      },
      onEditOpeningType: (kind) => {
        setResourcesTab(kind === "door" ? "doorStyles" : "windowStyles");
        setResourcesOpen(true);
      },
      // ── Dach-Attribute (nur bei selektiertem Dach) ─────────────────────────
      onSetRoofPatch: (patch) => {
        if (selection?.kind === "roof") updateRoof(selection.id, patch);
      },
      // ── Treppen-Attribute (nur bei selektierter Treppe) ────────────────────
      onSetStairShape: (shape) => {
        if (selection?.kind === "stair") updateStair(selection.id, { shape });
      },
      onSetStairWidth: (width) => {
        if (selection?.kind === "stair" && width > 0)
          updateStair(selection.id, { width });
      },
      onSetStairSteps: (stepCount) => {
        if (selection?.kind === "stair" && stepCount >= 2)
          updateStair(selection.id, { stepCount: Math.round(stepCount) });
      },
      onSetStairRise: (totalRise) => {
        if (selection?.kind === "stair" && totalRise > 0)
          updateStair(selection.id, { totalRise });
      },
      onSetStairUp: (up) => {
        if (selection?.kind === "stair") updateStair(selection.id, { up });
      },
      onSetStairReferenz: (referenz) => {
        if (selection?.kind === "stair") updateStair(selection.id, { referenz });
      },
      // Typ-Zuweisung (Bibliothek): Treppentyp per typeId; leerer String löst die
      // Zuweisung (Inline-Verhalten). Treibt u. a. die 3D-Tragart (massiv/offen).
      onSetStairType: (typeId) => {
        if (selection?.kind === "stair")
          updateStair(selection.id, { typeId: typeId || undefined });
      },
      // ── Raum-Attribute (nur bei selektiertem Raum) ─────────────────────────
      onSetRoomName: (name) => {
        if (selection?.kind === "room") updateRoom(selection.id, { name });
      },
      onSetRoomSia: (category) => {
        if (selection?.kind === "room") updateRoom(selection.id, { siaCategory: category });
      },
      onEditRoomStamp: (roomId) => onOpenStampEditor(roomId),
      // ── Extrusions-Attribute (truck-Integration; nur bei selektiertem Körper) ──
      onSetExtrudedSolidHeight: (height) => {
        if (selection?.kind !== "extrudedSolid" || !(height > 0)) return;
        const id = selection.id;
        setProject((p) => ({
          ...p,
          extrudedSolids: (p.extrudedSolids ?? []).map((s) =>
            s.id === id ? { ...s, height } : s,
          ),
        }));
      },
      onSetExtrudedSolidTaper: (taper) => {
        if (selection?.kind !== "extrudedSolid") return;
        const clamped = Math.min(1, Math.max(0, taper));
        const id = selection.id;
        setProject((p) => ({
          ...p,
          extrudedSolids: (p.extrudedSolids ?? []).map((s) =>
            s.id === id ? { ...s, taper: clamped } : s,
          ),
        }));
      },
      // ── Stützen-Attribute (Tragwerk; nur bei selektierter Stütze) ──────────
      onSetColumnProfileKind: (kind) => {
        if (selection?.kind !== "column") return;
        const id = selection.id;
        setProject((p) => ({
          ...p,
          columns: (p.columns ?? []).map((c) => {
            if (c.id !== id) return c;
            if (kind === c.profile.kind) return c;
            // Profil-Typ wechseln: sinnvolles Mass aus dem bisherigen ableiten.
            if (kind === "round") {
              const r =
                c.profile.kind === "rect"
                  ? Math.max(c.profile.width, c.profile.depth) / 2
                  : c.profile.radius;
              return { ...c, profile: { kind: "round", radius: r } };
            }
            const side = c.profile.kind === "round" ? c.profile.radius * 2 : 0.3;
            return { ...c, profile: { kind: "rect", width: side, depth: side } };
          }),
        }));
      },
      onSetColumnWidth: (width) => {
        if (selection?.kind !== "column" || !(width > 0)) return;
        const id = selection.id;
        setProject((p) => ({
          ...p,
          columns: (p.columns ?? []).map((c) =>
            c.id === id && c.profile.kind === "rect"
              ? { ...c, profile: { ...c.profile, width } }
              : c,
          ),
        }));
      },
      onSetColumnDepth: (depth) => {
        if (selection?.kind !== "column" || !(depth > 0)) return;
        const id = selection.id;
        setProject((p) => ({
          ...p,
          columns: (p.columns ?? []).map((c) =>
            c.id === id && c.profile.kind === "rect"
              ? { ...c, profile: { ...c.profile, depth } }
              : c,
          ),
        }));
      },
      onSetColumnRadius: (radius) => {
        if (selection?.kind !== "column" || !(radius > 0)) return;
        const id = selection.id;
        setProject((p) => ({
          ...p,
          columns: (p.columns ?? []).map((c) =>
            c.id === id && c.profile.kind === "round"
              ? { ...c, profile: { ...c.profile, radius } }
              : c,
          ),
        }));
      },
      onSetColumnHeight: (height) => {
        if (selection?.kind !== "column" || !(height > 0)) return;
        const id = selection.id;
        setProject((p) => ({
          ...p,
          columns: (p.columns ?? []).map((c) => (c.id === id ? { ...c, height } : c)),
        }));
      },
      onSetColumnRotation: (deg) => {
        if (selection?.kind !== "column" || !Number.isFinite(deg)) return;
        const id = selection.id;
        const rotation = (deg * Math.PI) / 180;
        setProject((p) => ({
          ...p,
          columns: (p.columns ?? []).map((c) => (c.id === id ? { ...c, rotation } : c)),
        }));
      },
      // ── Site-/Kontext-Schicht ──────────────────────────────────────────────
      contextObjects: project.context ?? [],
      onAddContextObjects: addContextObjectsAndFit,
      onRemoveContextObject: removeContextObject,
      onGenerateTerrain: generateTerrain,
      onImportDxf: () => dxfInputRef.current?.click(),
      // ── Element-Baum (Elemente-Panel) ────────────────────────────────────
      onSelectScheduleRow: (
        kind: ScheduleKind,
        id: string,
        floorId: string | undefined,
        opts?: { zoom?: boolean },
      ) => {
        const applySelection = () => {
          setSelectedWallIds([]);
          setSelectedDrawingId(null);
          setSelectedCeilingIds([]);
          setSelectedOpeningIds([]);
          setSelectedStairIds([]);
          setSelectedRoomIds([]);
          setSelectedExtrudedSolidIds([]);
          setSelectedColumnIds([]);
          setSelectedRoofIds([]);
          switch (kind) {
            case "Wand":
              setSelectedWallIds([id]);
              break;
            case "Decke":
              setSelectedCeilingIds([id]);
              break;
            case "Fenster":
            case "Öffnung":
              setSelectedOpeningIds([id]);
              break;
            case "Treppe":
              setSelectedStairIds([id]);
              break;
            case "Extrusion":
              setSelectedExtrudedSolidIds([id]);
              break;
            default:
              // z. B. Legacy-„Tür"-Datensätze (project.doors) — kein Auswahl-Kanal.
              return;
          }
          if (opts?.zoom) requestAnimationFrame(() => planViewRef.current?.fit());
        };
        if (floorId && floorId !== activeLevelId) {
          // Der Geschosswechsel-Effekt (oben, deps [activeLevelId]) leert die
          // Auswahl NACH diesem Render — die neue Auswahl daher einen Tick
          // später anwenden, sonst überschreibt der Effekt sie sofort wieder.
          setActiveLevelId(floorId);
          requestAnimationFrame(applySelection);
        } else {
          applySelection();
        }
      },

      // ── Ausschnitte / View-Snapshots (DOSSIER A2) ─────────────────────────
      // Erfassen: aktuellen Darstellungszustand einsammeln (View-State +
      // Sichtbarkeits-Snapshots + aktive Overrides) → pure captureViewSnapshot →
      // an project.viewSnapshots anhängen (im Dokument, nicht localStorage).
      onCaptureViewSnapshot: (name: string, folderId?: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const st: ViewSnapshotState = {
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
        const snap = captureViewSnapshot(`vs-${Date.now()}`, trimmed, st);
        // Neuer Ausschnitt landet im aktiven Ordner (falls das Panel einen
        // mitgibt), sonst auf der Wurzelebene — additiv (folderId optional).
        const full = folderId ? { ...snap, folderId } : snap;
        setProject((p) => ({
          ...p,
          viewSnapshots: [...(p.viewSnapshots ?? []), full],
        }));
      },

      // Wiederherstellen: ALLE Felder zurückspielen. Reihenfolge: Geschoss ZUERST
      // (setActiveLevelId setzt viewType provisorisch aus viewTypeByLevel), danach
      // die Ansicht (überschreibt es synchron), dann Sichtbarkeit + Overrides.
      // Die Store-Setter laufen synchron im selben Tick; nur den imperativen
      // Massstab-Zoom (Plan muss für den neuen View gemountet sein) via rAF
      // nachziehen — analog zum BIM-Tree-Geschosswechsel.
      onApplyViewSnapshot: (id: string) => {
        const snap = (project.viewSnapshots ?? []).find((s) => s.id === id);
        if (!snap) return;
        const st = readViewSnapshot(snap);
        setActiveLevelId(st.activeLevelId);
        setViewType(st.viewType);
        setView3d(st.view3d);
        setFov(st.fov);
        setDetail(st.detail);
        setScaleDenominator(st.scaleDenominator);
        applyLayerVisibility(st.layerVisibility);
        applyDrawingVisibility(st.drawingVisibility);
        setProject((p) => ({
          ...p,
          overrideRules: applyOverrideRuleEnabled(
            p.overrideRules ?? [],
            st.enabledOverrideRuleIds,
          ),
        }));
        requestAnimationFrame(() =>
          planViewRef.current?.applyScale(st.scaleDenominator),
        );
        // Klick = Anwenden UND Anwählen: der Ausschnitt bleibt markiert, bis der
        // Nutzer eine erfasste Grösse ändert (Abweichungs-Effekt löscht ihn dann).
        setSelectedViewSnapshotId(id);
      },

      onRenameViewSnapshot: (id: string, name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        setProject((p) => ({
          ...p,
          viewSnapshots: (p.viewSnapshots ?? []).map((s) =>
            s.id === id ? { ...s, name: trimmed } : s,
          ),
        }));
      },

      onDeleteViewSnapshot: (id: string) => {
        setProject((p) => ({
          ...p,
          viewSnapshots: (p.viewSnapshots ?? []).filter((s) => s.id !== id),
        }));
        if (selectedViewSnapshotId === id) setSelectedViewSnapshotId(null);
      },

      // ── Ausschnitte-Baum (Ordner, DOSSIER A2) ─────────────────────────────
      // Immutable CRUD über pure Helfer (state/viewSnapshotFolders.ts). Löschen
      // zieht Inhalt auf die Elternebene hoch (kein Datenverlust).
      onAddViewSnapshotFolder: (parentId) => {
        const id = `vsf-${Date.now()}`;
        const folder = createViewSnapshotFolder(
          id,
          t("viewsnap.folder.defaultName"),
          parentId,
        );
        setProject((p) => ({
          ...p,
          viewSnapshotFolders: [...(p.viewSnapshotFolders ?? []), folder],
        }));
        return id;
      },
      onRenameViewSnapshotFolder: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        setProject((p) => ({
          ...p,
          viewSnapshotFolders: (p.viewSnapshotFolders ?? []).map((f) =>
            f.id === id ? { ...f, name: trimmed } : f,
          ),
        }));
      },
      onDeleteViewSnapshotFolder: (id) => {
        setProject((p) => {
          const { folders, snapshots } = deleteViewSnapshotFolder(
            id,
            p.viewSnapshotFolders ?? [],
            p.viewSnapshots ?? [],
          );
          return { ...p, viewSnapshotFolders: folders, viewSnapshots: snapshots };
        });
      },
      onMoveViewSnapshotToFolder: (snapshotId, folderId) => {
        setProject((p) => ({
          ...p,
          viewSnapshots: moveSnapshotToFolder(
            p.viewSnapshots ?? [],
            snapshotId,
            folderId,
          ),
        }));
      },
      onMoveViewSnapshotFolder: (folderId, parentId) => {
        setProject((p) => ({
          ...p,
          viewSnapshotFolders: moveViewSnapshotFolder(
            p.viewSnapshotFolders ?? [],
            folderId,
            parentId,
          ),
        }));
      },

      // Footer-Bar des Ausschnitte-Panels: die aktuell „angewählte" Id plus
      // Lesezugriff auf die benannten Sichtbarkeits-Kombinationen (localStorage),
      // damit der Footer den Kombi-NAMEN zu den gespeicherten Maps auflösen kann.
      selectedViewSnapshotId,
      listLayerCombos,
      loadLayerCombo,
      listDrawingCombos,
      loadDrawingCombo,

      // ── Layouts / Masterlayouts (DOSSIER A3) ──────────────────────────────
      // Immutable CRUD über pure Helfer (panels/layoutModel.ts); das Blatt öffnet
      // als erstklassige Ansicht IM HAUPT-Viewport (activeLayoutId, Phase 2b).
      // Anlegen öffnet es direkt; Löschen schliesst es, falls es das offene trifft.
      onAddLayout: (name, paper, orientation) => {
        const lay = createLayout(`lay-${Date.now()}`, name, paper, orientation);
        setProject((p) => ({ ...p, layouts: [...(p.layouts ?? []), lay] }));
        setActiveLayoutId(lay.id);
      },
      onRenameLayout: (id, name) => {
        setProject((p) => ({
          ...p,
          layouts: (p.layouts ?? []).map((l) =>
            l.id === id ? { ...l, name } : l,
          ),
        }));
      },
      onDeleteLayout: (id) => {
        setProject((p) => ({
          ...p,
          layouts: (p.layouts ?? []).filter((l) => l.id !== id),
        }));
        setActiveLayoutId((cur) => (cur === id ? null : cur));
      },
      onOpenLayout: (id) => setActiveLayoutId(id),
      onAddMasterLayout: (name) => {
        const m = createMasterLayout(`mas-${Date.now()}`, name, "a4", "portrait");
        setProject((p) => ({
          ...p,
          masterLayouts: [...(p.masterLayouts ?? []), m],
        }));
      },
      onRenameMasterLayout: (id, name) => {
        setProject((p) => ({
          ...p,
          masterLayouts: (p.masterLayouts ?? []).map((m) =>
            m.id === id ? { ...m, name } : m,
          ),
        }));
      },
      onDeleteMasterLayout: (id) => {
        // Master löschen UND Bindungen der Layouts lösen (masterId → undefined).
        setProject((p) => ({
          ...p,
          masterLayouts: (p.masterLayouts ?? []).filter((m) => m.id !== id),
          layouts: (p.layouts ?? []).map((l) =>
            l.masterId === id ? { ...l, masterId: undefined } : l,
          ),
        }));
      },
      onPatchMasterLayout: (id, patch) => {
        setProject((p) => ({
          ...p,
          masterLayouts: (p.masterLayouts ?? []).map((m) =>
            m.id === id ? { ...m, ...patch } : m,
          ),
        }));
      },

      // ── Layouts-Baum (Ordner) + Erstell-Dialoge (DOSSIER A3) ────────────
      onAddLayoutFolder: (parentId) => {
        const id = `folder-${Date.now()}`;
        const folder = createLayoutFolder(id, t("layouts.folder.defaultName"), parentId);
        setProject((p) => ({
          ...p,
          layoutFolders: [...(p.layoutFolders ?? []), folder],
        }));
        return id;
      },
      onAddMasterFolder: (parentId) => {
        const id = `mfolder-${Date.now()}`;
        const folder = createLayoutFolder(
          id,
          t("layouts.folder.defaultName"),
          parentId,
          "master",
        );
        setProject((p) => ({
          ...p,
          layoutFolders: [...(p.layoutFolders ?? []), folder],
        }));
        return id;
      },
      onDeleteMasterFolder: (id) => {
        setProject((p) => {
          const { folders, masters } = deleteMasterFolder(
            id,
            p.layoutFolders ?? [],
            p.masterLayouts ?? [],
          );
          return { ...p, layoutFolders: folders, masterLayouts: masters };
        });
      },
      onRenameLayoutFolder: (id, name) => {
        setProject((p) => ({
          ...p,
          layoutFolders: (p.layoutFolders ?? []).map((f) =>
            f.id === id ? { ...f, name } : f,
          ),
        }));
      },
      onDeleteLayoutFolder: (id) => {
        setProject((p) => {
          const { folders, layouts } = deleteLayoutFolder(
            id,
            p.layoutFolders ?? [],
            p.layouts ?? [],
          );
          return { ...p, layoutFolders: folders, layouts };
        });
      },
      onCreateLayout: (opts) => {
        const id = `lay-${Date.now()}`;
        // Bei gebundenem Master erbt das Blatt dessen Papier/Ausrichtung/Grösse.
        const master = opts.masterId
          ? (project.masterLayouts ?? []).find((m) => m.id === opts.masterId)
          : undefined;
        const paper = master?.paper ?? opts.paper;
        const orientation = master?.orientation ?? opts.orientation;
        const customWidthMm = master ? master.customWidthMm : opts.customWidthMm;
        const customHeightMm = master ? master.customHeightMm : opts.customHeightMm;
        const lay = createLayout(id, t("layouts.defaultName"), paper, orientation);
        const full = {
          ...lay,
          ...(opts.masterId ? { masterId: opts.masterId } : {}),
          ...(opts.folderId ? { folderId: opts.folderId } : {}),
          ...(customWidthMm !== undefined && customHeightMm !== undefined
            ? { customWidthMm, customHeightMm }
            : {}),
        };
        setProject((p) => ({ ...p, layouts: [...(p.layouts ?? []), full] }));
        return id;
      },
      onCreateMasterLayout: (opts) => {
        const id = `mas-${Date.now()}`;
        const custom =
          opts.customWidthMm !== undefined && opts.customHeightMm !== undefined
            ? { widthMm: opts.customWidthMm, heightMm: opts.customHeightMm }
            : undefined;
        const m = createMasterLayout(
          id,
          t("layouts.defaultMasterName"),
          opts.paper,
          opts.orientation,
          custom,
        );
        const full = opts.folderId ? { ...m, folderId: opts.folderId } : m;
        setProject((p) => ({
          ...p,
          masterLayouts: [...(p.masterLayouts ?? []), full],
        }));
        return id;
      },
      onExportFolderPdf: (folderId) => {
        const folder = (project.layoutFolders ?? []).find((f) => f.id === folderId);
        const name = folder?.name?.trim() || "layouts";
        void saveFolderPdf(project, folderId, name);
      },
      onMoveLayoutToFolder: (layoutId, folderId) => {
        setProject((p) => ({
          ...p,
          layouts: moveLayoutToFolder(p.layouts ?? [], layoutId, folderId),
        }));
      },
      onMoveFolderToFolder: (folderId, parentId) => {
        setProject((p) => ({
          ...p,
          layoutFolders: moveFolderToFolder(
            p.layoutFolders ?? [],
            folderId,
            parentId,
          ),
        }));
      },
    };
    return value;
    // setProject-Closures sind stabil genug; Neuberechnung bei project/active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project,
    activeLevelId,
    activeCategoryCode,
    activeTool,
    activeWallTypeId,
    snap,
    viewType,
    view3d,
    fov,
    detail,
    scaleDenominator,
    selection,
    selectedViewSnapshotId,
  ]);

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

  // ── Tab-Drag-Steuerung (Reorder / Einreihen / Stapeln / Lösen) ────────────
  // Der Controller (usePanelDrag) klärt anhand der Bewegung Klick vs. Ziehen
  // und löst beim Loslassen das Ziel auf; die Auflösung selbst macht der Slice.
  const { drag, startTabDrag } = usePanelDrag({
    onActivate: activateTab,
    onJoinGroup: joinGroup,
    onNewGroup: newGroup,
    onDropFloat: dropFloat,
  });

  // Zustand für die Rand-Zonen-Hervorhebung beim Titel-Drag eines Fensters.
  // `floatDragging` schaltet die Zonen ein (sobald die Titelleiste gezogen
  // wird), `floatDragHover` markiert die gerade überfahrene Zone.
  const [floatDragging, setFloatDragging] = useState(false);
  const [floatDragHover, setFloatDragHover] = useState<DockId | null>(null);

  // Titel-Drag eines schwebenden Fensters über eine Rand-Zone: liefert true,
  // wenn das Fenster angedockt wurde (dann unterbleibt das reine Verschieben).
  // Trefferprüfung über die Datenattribute der Rand-Zonen (data-drop-zone).
  const onFloatTitleDrop = (panelId: string, clientX: number, clientY: number): boolean => {
    setFloatDragging(false);
    setFloatDragHover(null);
    const zone = document
      .elementsFromPoint(clientX, clientY)
      .find((el) => (el as HTMLElement).dataset?.dropZone !== undefined) as
      | HTMLElement
      | undefined;
    if (!zone) return false;
    const dock = zone.dataset.dropZone as DockId;
    dockFloatTo(panelId, dock);
    return true;
  };

  const onFloatTitleDrag = (_panelId: string, clientX: number, clientY: number) => {
    if (!floatDragging) setFloatDragging(true);
    const zone = document
      .elementsFromPoint(clientX, clientY)
      .find((el) => (el as HTMLElement).dataset?.dropZone !== undefined) as
      | HTMLElement
      | undefined;
    setFloatDragHover(zone ? (zone.dataset.dropZone as DockId) : null);
  };

  // Ein Dock wird nur gerendert, wenn es Tabs hat — ein leeres Dock soll die
  // Mitte nicht stauchen. (Rechtes Dock ist standardmäßig leer: Ressourcen ist
  // ein schwebendes Fenster.)
  const leftHasTabs = layout.left.groups.length > 0;
  const rightHasTabs = layout.right.groups.length > 0;
  // Rand-Andock-Zonen sind aktiv, solange irgendeine Drag-Geste läuft (Tab-Drag
  // ODER Titel-Drag eines schwebenden Fensters). Die gerade überfahrene Zone
  // (für die Hervorhebung) kommt aus dem Tab-Drag-Hover bzw. dem Float-Hover.
  const dragActive = drag !== null || floatDragging;
  const activeZone: DockId | null =
    drag && drag.hover.kind === "zone" ? drag.hover.dock : floatDragHover;

  // Handler-Bündel für das schwebende Ressourcen-Fenster (ResourceManager).
  const resourceHandlers: ResourceManagerHandlers = {
    onPatchComponent: patchComponent,
    onPatchWallType: patchWallType,
    onAddWallType: addWallType,
    onDeleteWallType: deleteWallType,
    onPatchCeilingType: patchCeilingType,
    onAddCeilingType: addCeilingType,
    onDeleteCeilingType: deleteCeilingType,
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
    onSetOverrideRules: setOverrideRules,
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
  const patchOpenLayout = (id: string, fn: (l: Layout) => Layout) =>
    setProject((p) => ({
      ...p,
      layouts: (p.layouts ?? []).map((l) => (l.id === id ? fn(l) : l)),
    }));

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
  const floorDisplay: DisplayResolver = useMemo(() => {
    const visible = new Map(
      project.drawingLevels.map((z) => [z.id, z.visible]),
    );
    return (id) =>
      itemDisplay(drawingLevelsMode, id === activeLevelId, visible.get(id) ?? false);
  }, [project.drawingLevels, drawingLevelsMode, activeLevelId]);

  // Resolver: je Kategorie-Code die Render-Entscheidung (Kategorien sind nie
  // „aktiv"). Wirkt in Grundriss UND 3D.
  const categoryDisplay: CategoryDisplayResolver & DisplayResolver = useMemo(
    () => (code) => itemDisplay(layersMode, false, codeVisible.get(code) ?? false),
    [layersMode, codeVisible],
  );

  // Stabiler Schlüssel der 3D-Display-Entscheidungen (Resolver sind nicht
  // referenzstabil → triggert sonst keinen Neuaufbau).
  const displayKey = `${drawingLevelsMode}|${layersMode}|${activeLevelId}`;

  // Dokument-Tabs der Zeichenflächen-Kopfzeile — ein Tab je Geschoss-
  // Grundriss (siehe DrawingTabs.tsx). Teilt sich `activeLevelId`/
  // `setActiveLevelId` mit dem Panel „Zeichnungsebenen".
  const drawings = useMemo(
    () => deriveDrawings(project.drawingLevels),
    [project.drawingLevels],
  );

  // ── Ableitungen für Oberleiste + Status-Leiste ────────────────────────────
  // Eine zoom-/cursor-fähige Plan-Ansicht ist nur im Grundriss eines Geschosses
  // aktiv. Sonst sind Cursor/Zoom bedeutungslos (PlanView ist nicht montiert →
  // das Handle ist null, Aktionen sind No-Ops).
  const planActive = activeLevel.kind === "floor" && viewType === "grundriss";
  // Plan-Renderer-Umschalter (Statusleiste): reines Ableiten/Setzen des `engine`-
  // URL-Params (siehe PlanView.tsx `wantWasm`); die Renderer-Auswahl selbst bleibt
  // dort. Ein Wechsel lädt die Seite neu — kein Live-Remount der Renderer-Hooks.
  // Persistiert in localStorage, damit die Wahl einen Neustart ohne URL-Param
  // übersteht (z.B. die Electron-App startet immer auf der Basis-URL).
  const RENDERER_STORAGE_KEY = "cad.rendererMode";
  const webGpuAvailable = typeof navigator !== "undefined" && "gpu" in navigator;
  const rendererMode: RendererMode = (() => {
    const fromUrl = new URLSearchParams(window.location.search).get("engine");
    if (fromUrl === "wasm") return "wasm";
    if (fromUrl === "webgl2") return "webgl2";
    const fromStorage = window.localStorage.getItem(RENDERER_STORAGE_KEY);
    if (fromStorage === "webgl2") return "webgl2";
    if (fromStorage === "wasm") return "wasm";
    // Keine explizite Wahl (weder URL noch localStorage) — Nordstern (WASM)
    // ist Standard, sofern WebGPU verfügbar ist; sonst WebGL2 als Fallback.
    return webGpuAvailable ? "wasm" : "webgl2";
  })();
  const setRendererMode = (mode: RendererMode) => {
    window.localStorage.setItem(RENDERER_STORAGE_KEY, mode);
    const url = new URL(window.location.href);
    if (mode === "wasm") url.searchParams.set("engine", "wasm");
    else url.searchParams.delete("engine");
    window.location.assign(url.toString());
  };
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
  const onExportPdf = async (decision: ExportPdfDecision) => {
    const plan = generatePlan(
      project,
      activeLevel.id,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
    );
    await savePlanPdf(plan, {
      scaleDenominator: decision.scaleDenominator,
      paper: decision.paper,
      orientation: decision.orientation,
      title: activeLevel.name,
      subtitle: project.name,
      fileName: `${project.name}-${activeLevel.name}`,
    });
    setExportOpen(false);
  };

  // DXF-Export: erzeugt den Plan mit EXAKT denselben Eingaben wie die Ansicht und
  // schreibt ihn als Modell-Space-DXF in echten Metern (1:1). Layer aus den
  // Kategorie-Ebenen; jede Entity auf ihrem Kategorie-Layer.
  const onExportDxf = (decision: ExportDxfDecision) => {
    const plan = generatePlan(
      project,
      activeLevel.id,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      planColorMode === "mono",
    );
    savePlanDxf(plan, project, {
      title: activeLevel.name,
      includeHatches: decision.includeHatches,
      fileName: `${project.name}-${activeLevel.name}`,
    });
    setExportDxfOpen(false);
  };

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

  // ── Maus-Schema: Auswahl + Kontextmenü aus Grundriss / 3D ─────────────────
  // Links-Klick im Grundriss: genau eine Wand wählen (Menge ersetzen) bzw.
  // Leerraum → Auswahl löschen.
  // Doppelklick auf einen Raum-Stempel: den Raum wählen + den Stempel-Editor
  // öffnen (Rich-Text-Popup).
  const onOpenStampEditor = (roomId: string) => {
    setSelectedRoomIds([roomId]);
    setSelectedWallIds([]);
    setSelectedDrawingId(null);
    setSelectedCeilingIds([]);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
    setStampEditorRoomId(roomId);
  };
  // Doppelklick auf ein Text-2D-Element: selektieren + Inhalts-Editor öffnen.
  const onEditDrawingText = (drawingId: string) => {
    const d = project.drawings2d.find((x) => x.id === drawingId);
    if (!d || d.geom.shape !== "text") return;
    setSelectedDrawingId(drawingId);
    setSelectedWallIds([]);
    setSelectedCeilingIds([]);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedRoomIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
    setEditTextId(drawingId);
  };
  // Bearbeiteten Text-Inhalt übernehmen (immutabel; nur bei Text-Geometrie).
  const commitTextEdit = (value: string) => {
    const id = editTextId;
    if (!id) return;
    const text = value.trim();
    if (text !== "") {
      setProject((p) => ({
        ...p,
        drawings2d: p.drawings2d.map((d) =>
          d.id === id && d.geom.shape === "text"
            ? { ...d, geom: { ...d.geom, text } }
            : d,
        ),
      }));
    }
    setEditTextId(null);
  };
  const onPlanSelect = (sel: PlanSelection) => {
    // Shift+Klick: Mehrfach-Auswahl — getroffenes Element zu-/abschalten, den
    // Rest behalten (Wände und 2D-Zeichnungen unabhängig, gemischte Auswahl
    // erlaubt). Leerraum-Klick mit Shift lässt die Auswahl unverändert.
    if (sel.shift) {
      if (sel.wallId) {
        const id = sel.wallId;
        setSelectedWallIds(
          selectedWallIds.includes(id)
            ? selectedWallIds.filter((w) => w !== id)
            : [...selectedWallIds, id],
        );
      } else if (sel.drawingId) {
        const id = sel.drawingId;
        setSelectedDrawingIds(
          selectedDrawingIds.includes(id)
            ? selectedDrawingIds.filter((d) => d !== id)
            : [...selectedDrawingIds, id],
        );
      } else if (sel.ceilingId) {
        const id = sel.ceilingId;
        setSelectedCeilingIds(
          selectedCeilingIds.includes(id)
            ? selectedCeilingIds.filter((c) => c !== id)
            : [...selectedCeilingIds, id],
        );
      } else if (sel.openingId) {
        const id = sel.openingId;
        setSelectedOpeningIds(
          selectedOpeningIds.includes(id)
            ? selectedOpeningIds.filter((o) => o !== id)
            : [...selectedOpeningIds, id],
        );
      } else if (sel.stairId) {
        const id = sel.stairId;
        setSelectedStairIds(
          selectedStairIds.includes(id)
            ? selectedStairIds.filter((s) => s !== id)
            : [...selectedStairIds, id],
        );
      } else if (sel.roomId) {
        const id = sel.roomId;
        setSelectedRoomIds(
          selectedRoomIds.includes(id)
            ? selectedRoomIds.filter((r) => r !== id)
            : [...selectedRoomIds, id],
        );
      } else if (sel.extrudedSolidId) {
        const id = sel.extrudedSolidId;
        setSelectedExtrudedSolidIds(
          selectedExtrudedSolidIds.includes(id)
            ? selectedExtrudedSolidIds.filter((x) => x !== id)
            : [...selectedExtrudedSolidIds, id],
        );
      } else if (sel.columnId) {
        const id = sel.columnId;
        setSelectedColumnIds(
          selectedColumnIds.includes(id)
            ? selectedColumnIds.filter((x) => x !== id)
            : [...selectedColumnIds, id],
        );
      } else if (sel.roofId) {
        const id = sel.roofId;
        setSelectedRoofIds(
          selectedRoofIds.includes(id)
            ? selectedRoofIds.filter((x) => x !== id)
            : [...selectedRoofIds, id],
        );
      }
      return;
    }
    // Ohne Shift: ersetzen. Öffnung hat Vorrang (ihr Symbol liegt in der Lücke),
    // dann Wand, dann 2D-Element, dann Decke; sonst leeren. Die Kanäle schließen
    // sich gegenseitig aus.
    // Alle Kanäle ausser dem gewählten leeren — als Helfer, damit jeder Zweig
    // (inkl. des neuen Dach-Kanals) konsistent bleibt.
    const clearOthers = (keep: string) => {
      if (keep !== "wall") setSelectedWallIds([]);
      if (keep !== "drawing") setSelectedDrawingId(null);
      if (keep !== "ceiling") setSelectedCeilingIds([]);
      if (keep !== "opening") setSelectedOpeningIds([]);
      if (keep !== "stair") setSelectedStairIds([]);
      if (keep !== "room") setSelectedRoomIds([]);
      if (keep !== "extrudedSolid") setSelectedExtrudedSolidIds([]);
      if (keep !== "column") setSelectedColumnIds([]);
      if (keep !== "roof") setSelectedRoofIds([]);
    };
    if (sel.openingId) {
      setSelectedOpeningIds([sel.openingId]);
      clearOthers("opening");
    } else if (sel.wallId) {
      setSelectedWallIds([sel.wallId]);
      clearOthers("wall");
    } else if (sel.columnId) {
      setSelectedColumnIds([sel.columnId]);
      clearOthers("column");
    } else if (sel.drawingId) {
      setSelectedDrawingId(sel.drawingId);
      clearOthers("drawing");
    } else if (sel.extrudedSolidId) {
      setSelectedExtrudedSolidIds([sel.extrudedSolidId]);
      clearOthers("extrudedSolid");
    } else if (sel.ceilingId) {
      setSelectedCeilingIds([sel.ceilingId]);
      clearOthers("ceiling");
    } else if (sel.stairId) {
      setSelectedStairIds([sel.stairId]);
      clearOthers("stair");
    } else if (sel.roomId) {
      setSelectedRoomIds([sel.roomId]);
      clearOthers("room");
    } else if (sel.roofId) {
      setSelectedRoofIds([sel.roofId]);
      clearOthers("roof");
    } else {
      clearOthers("");
    }
  };
  // Links-Drag (Marquee) im Grundriss: die getroffene Wand-MENGE übernehmen
  // (nach CAD-Konvention von PlanView bestimmt). Ersetzt die bisherige Auswahl.
  const onPlanMarquee = (sel: MarqueeSelection) => {
    setSelectedWallIds(sel.wallIds);
    setSelectedDrawingIds(sel.drawingIds ?? []);
    // Decken/Öffnungen/Treppen/Räume/Extrusionen/Dächer sind (noch) nicht Teil
    // des Marquee → beim Aufziehen abwählen.
    setSelectedCeilingIds([]);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedRoomIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
  };
  // Rechts-Klick im Grundriss: Wand-Kontextmenü. Trifft der Klick eine Wand, die
  // NICHT bereits in der Auswahl ist, wird die Auswahl auf sie gesetzt (damit die
  // Aktionen einen Bezug haben); innerhalb einer bestehenden Mehrfachauswahl
  // bleibt die Menge erhalten.
  const onPlanContextMenu = (info: {
    clientX: number;
    clientY: number;
    model: Vec2;
  }) => {
    const wallId = hitTestWall(project, activeLevel.id, visibleCodes, info.model);
    if (wallId && !selectedWallIds.includes(wallId)) setSelectedWallIds([wallId]);
    setMenu({ kind: "plan", x: info.clientX, y: info.clientY, wallId });
  };
  // Links-Klick im 3D: per Raycast getroffene Wand wählen (Einzelauswahl).
  const onViewportSelectWall = (wallId: string | null) => {
    setSelectedWallIds(wallId ? [wallId] : []);
    if (wallId) {
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
    }
  };
  // Links-Klick im 3D: per Raycast getroffene Treppe wählen (Einzelauswahl).
  const onViewportSelectStair = (stairId: string | null) => {
    setSelectedStairIds(stairId ? [stairId] : []);
    if (stairId) {
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
    }
  };
  // Links-Klick im 3D: per Raycast getroffene Decke wählen (Einzelauswahl).
  const onViewportSelectCeiling = (ceilingId: string | null) => {
    setSelectedCeilingIds(ceilingId ? [ceilingId] : []);
    if (ceilingId) {
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedStairIds([]);
      setSelectedOpeningIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
    }
  };
  // Links-Klick im 3D: per Raycast getroffene Öffnung wählen (Einzelauswahl).
  const onViewportSelectOpening = (openingId: string | null) => {
    setSelectedOpeningIds(openingId ? [openingId] : []);
    if (openingId) {
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
    }
  };
  // Links-KLICK im Nordstern-3D-Viewport (WASM, TS-Raycast): getroffenes Bauteil
  // wählen, sodass das Attribute-/Objekt-Info-Panel es zeigt (erster Schritt zur
  // 3D-Editierbarkeit). `additive` (Shift/Ctrl) = zur Auswahl DERSELBEN Art
  // hinzufügen, sonst ersetzen; beim Setzen die ANDEREN Arten-Arrays leeren
  // (Einzel-Selektion über Arten hinweg, konsistent mit dem 2D-Verhalten).
  // Leertreffer (kein Bauteil) → alle Selektionen leeren.
  const onViewport3dPick = (hit: Pick3dHit, additive: boolean) => {
    if (!hit) {
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedDrawingId(null);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      return;
    }
    // Öffnung (Fenster/Tür) und Treppe sind jetzt auch im WASM-Viewport pickbar
    // (raycast3d/pickGeometry). Jede Art ersetzt die Auswahl exklusiv; nur Wände
    // unterstützen additive Mehrfachauswahl (wie bisher).
    if (hit.kind === "opening") {
      setSelectedOpeningIds([hit.id]);
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedDrawingId(null);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      return;
    }
    if (hit.kind === "stair") {
      setSelectedStairIds([hit.id]);
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedDrawingId(null);
      setSelectedOpeningIds([]);
      setSelectedRoomIds([]);
      setSelectedExtrudedSolidIds([]);
      setSelectedColumnIds([]);
      setSelectedRoofIds([]);
      return;
    }
    if (hit.kind === "wall") {
      setSelectedWallIds(
        additive ? Array.from(new Set([...selectedWallIds, hit.id])) : [hit.id],
      );
      setSelectedCeilingIds([]);
    } else {
      setSelectedCeilingIds(
        additive ? Array.from(new Set([...selectedCeilingIds, hit.id])) : [hit.id],
      );
      setSelectedWallIds([]);
    }
    setSelectedDrawingId(null);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedRoomIds([]);
    setSelectedExtrudedSolidIds([]);
    setSelectedColumnIds([]);
    setSelectedRoofIds([]);
  };
  // Rechts-Klick im 3D: Wand-Kontextmenü an der Cursorposition.
  const onViewportContextMenu = (info: ViewportContextInfo) => {
    if (info.wallId && !selectedWallIds.includes(info.wallId)) {
      setSelectedWallIds([info.wallId]);
    }
    setMenu({
      kind: "viewport",
      x: info.clientX,
      y: info.clientY,
      wallId: info.wallId,
    });
  };

  // ── App-weites Drag & Drop einer DXF/DWG-Datei ────────────────────────────
  // dragover muss preventDefault rufen, sonst lässt der Browser nicht fallen.
  // dragenter/leave wird ausgezählt (Kind-Elemente lösen sonst Flackern aus).
  const dragDepthRef = useRef(0);
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onAppDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  };
  const onAppDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onAppDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  };
  const onAppDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) openImportForFile(f);
  };

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
        accept=".dxf,.dwg,text/plain"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openImportForFile(f);
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
      {/* Schmale globale Leiste: Marke/Ressourcen · Text-Formatierung ·
          Datei/Export/Einstellungen. Ansichts-/Zoom-/Darstellungs-Steuerung ist
          in den „Ansichten"-Ribbon-Tab gewandert (ViewRibbonTab, unten). */}
      <TopBar
        project={project}
        ribbonTab={ribbonTab}
        onRibbonTab={setRibbonTab}
        zoomEnabled={planActive}
        onExportPdf={() => setExportOpen(true)}
        onExportDxf={() => setExportDxfOpen(true)}
        onExportSchedule={onExportSchedule}
        onExportIfc={onExportIfc}
        onExportObj={onExportObj}
        onExportStl={onExportStl}
        viewType={viewType}
        fov={fov}
        onFov={setFov}
        cameraEnabled={activeLevel.kind === "floor"}
        resourcesOpen={resourcesOpen}
        onToggleResources={() => setResourcesOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
        onImport={() => dxfInputRef.current?.click()}
        onSaveProject={onSaveProject}
        onOpenProject={onOpenProject}
      />

      {/* Ribbon-Oberleiste (2D · 3D · BIM · Ansichten). Der „Ansichten"-Tab trägt
          die aus der TopBar gemergte Ansichts-/Zoom-/Darstellungs-Steuerung
          (ViewRibbonTab); die Werkzeug-Sidebar bleibt vorerst erhalten. */}
      <RibbonBar
        tab={ribbonTab}
        activeTool={activeTool}
        activeCommand={engineView.commandName}
        toolsEnabled={activeLevel.kind === "floor"}
        onSelectTool={onSelectTool}
        onRunCommand={onRunCommand}
        customItems={customItems}
        onToggleCustomItem={onToggleCustomItem}
        tabContent={{
          views: (
          <ViewRibbonTab
            viewToggleEnabled={activeLevel.kind === "floor"}
            viewType={viewType}
            onViewType={setViewType}
            view3d={view3d}
            onView3d={setView3d}
            detail={detail}
            onDetail={setDetail}
            detailEnabled={planActive}
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
          />
          ),
          "3d": (
            <Ribbon3dTab
              viewToggleEnabled={activeLevel.kind === "floor"}
              viewType={viewType}
              onViewType={setViewType}
              view3d={view3d}
              onView3d={setView3d}
              renderMode={renderMode}
              onRenderMode={setRenderMode}
              renderModeEnabled={viewType === "perspektive"}
              onRunCommand={onRunCommand}
              activeCommand={engineView.commandName}
            />
          ),
        }}
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
            handlers={{
              onBack: () => setActiveLayoutId(null),
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
              onAddAnnotation: (kind, init) =>
                patchOpenLayout(activeLayout.id, (l) =>
                  addAnnotationToLayout(
                    l,
                    createAnnotation(`ann-${Date.now()}`, kind, init),
                  ),
                ),
              onPatchAnnotation: (annotationId, patch) =>
                patchOpenLayout(activeLayout.id, (l) =>
                  patchAnnotationInLayout(l, annotationId, patch),
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
          hairline={lineMode === "display"}
          marqueeColor={marqueeColor}
          snapColor={snapColor}
          renderMode={renderMode}
          view3d={view3d}
          fov={fov}
          grid3dVisible={grid3dVisible}
          onToggleGrid3d={() => setGrid3dVisible(!grid3dVisible)}
          mono={planColorMode === "mono"}
          drawings={drawings}
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
          selectedRoomIds={selectedRoomIds}
          selectedRoofIds={selectedRoofIds}
          roomStamp={roomStamp}
          onStampMove={moveRoomStamp}
          onStampEdit={onOpenStampEditor}
          onEditDrawingText={onEditDrawingText}
          onPlanSelect={onPlanSelect}
          onPlanMarquee={onPlanMarquee}
          onSegmentCut={onSegmentCut}
          onPlanContextMenu={onPlanContextMenu}
          onViewportSelectWall={onViewportSelectWall}
          onViewportSelectCeiling={onViewportSelectCeiling}
          onViewportSelectOpening={onViewportSelectOpening}
          onViewportSelectStair={onViewportSelectStair}
          onViewportContextMenu={onViewportContextMenu}
          onViewport3dPick={onViewport3dPick}
          commandActive={commandActive}
          draft={draft}
          onWorkplanePoint={onWorkplanePoint}
          onWorkplaneConfirm={onWorkplaneConfirm}
          activeTool={activeTool}
          toolInputActive={toolInputActive}
          toolHandlers={toolHandlers}
          grips={grips}
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
        />
        {/* Command-Line (Rhino-artig) UNTER dem Viewport — nur Viewport-breit.
            Prompt + klickbare Inline-Optionen + Texteingabe + Autocomplete. */}
        <CommandLine
          ref={commandLineRef}
          // (c) Während eines Vertex-Griff-Drags belegt der Feld-Controller das
          // Befehlsfeld (Länge/Winkel). Läuft eine Auswahl-Transformation (Drehen
          // etc.), belegt sie Prompt + U/I/O/P + Winkel-/Distanzfeld. Sonst gilt die
          // Engine (Zeichnen/Ruhe). Griff-Drag hat Vorrang (schließen sich sonst aus).
          active={gripEdit ? true : activeTransform ? true : engineView.active}
          promptKey={
            gripEdit
              ? "cmd.edit.point"
              : activeTransform
              ? `transform.hint.${activeTransform.op}.${Math.min(
                  activeTransform.points.length,
                  activeTransform.op === "rotate" ? 2 : 1,
                )}`
              : engineView.promptKey
          }
          options={gripEdit ? [] : activeTransform ? transformOptions() : engineView.options}
          fields={
            gripEdit ? gripEditFields() : activeTransform ? transformFields() : engineView.fields
          }
          onSubmit={(text) => {
            if (gripEdit) {
              const v = parseFloat(text.replace(",", "."));
              if (isFinite(v)) submitGripEditValue(v);
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
            gripEdit ? cycleGripEditField() : activeTransform ? undefined : engine.cycleField()
          }
          onCancel={() =>
            gripEdit ? setGripEdit(null) : activeTransform ? cancelTransform() : engine.cancel()
          }
          suggest={(prefix) => engine.suggest(prefix)}
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
        cursor={planActive ? cursor : null}
        unit="m"
        referenceLines={referenceLines}
        onReferenceLines={setReferenceLines}
        referenceLinesEnabled={planActive}
        activeFloor={activeLevel.name}
        activeLayer={activeLayerName}
        lineMode={lineMode}
        onLineModeChange={setLineMode}
        lineModeEnabled={planActive}
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

      {/* Modaler Import-Dialog (DXF/DWG) — offen, sobald eine Datei gewählt/
          fallengelassen wurde. Liefert eine strukturierte Entscheidung an
          runImport (Ebene anlegen / Drawings anhängen / Meshes als Kontext). */}
      {importState && (
        <ImportDialog
          fileName={importState.fileName}
          isDwg={importState.isDwg}
          loading={importState.loading ?? false}
          parsed={importState.parsed}
          project={project}
          activeCategoryCode={activeCategoryCode}
          onImport={runImport}
          onClose={() => setImportState(null)}
        />
      )}

      {/* PDF-Export-Dialog (Grundriss → Vektor-PDF). Nur im Grundriss eines
          Geschosses sinnvoll; der Button ist sonst deaktiviert. */}
      {exportOpen && (
        <ExportPdfDialog
          initialScale={scaleDenominator}
          planTitle={activeLevel.name}
          contentMeters={exportContentMeters}
          onExport={onExportPdf}
          onClose={() => setExportOpen(false)}
        />
      )}

      {/* DXF-Export-Dialog (Grundriss → Modell-Space-DXF in Metern). */}
      {exportDxfOpen && (
        <ExportDxfDialog
          planTitle={activeLevel.name}
          onExport={onExportDxf}
          onClose={() => setExportDxfOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          marqueeColor={marqueeColor}
          onMarqueeColorChange={setMarqueeColor}
          snapColor={snapColor}
          onSnapColorChange={setSnapColor}
          project={project}
          setProject={setProject}
          rendererMode={rendererMode}
          webGpuAvailable={webGpuAvailable}
          onRendererModeChange={setRendererMode}
          layoutMenu={
            <LayoutMenu
              layout={layout}
              onApply={(l) => setLayout(reconcileLayout(l))}
            />
          }
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

      {/* Text-Inhalt-Editor: per Doppelklick auf ein Text-2D-Element geöffnet.
          Einzeilige Bearbeitung des Textinhalts (Absätze der Textspalte per „\n"
          werden dabei zu einer Zeile zusammengezogen — für mehrzeilige Spalten
          bleibt die Ersteingabe massgeblich). */}
      {editTextId &&
        (() => {
          const d = project.drawings2d.find((x) => x.id === editTextId);
          if (!d || d.geom.shape !== "text") return null;
          return (
            <PromptDialog
              title={t("cmd.text.label")}
              label={t("cmd.text.enter")}
              defaultValue={d.geom.text}
              type="text"
              onConfirm={commitTextEdit}
              onClose={() => setEditTextId(null)}
            />
          );
        })()}

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
            openLayerEditor: (code) =>
              setEditor({ kind: "layer", code, x: menu.x, y: menu.y }),
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
            bringToFront: () => reorderDrawings(selectedDrawingIds, "front"),
            bringForward: () => reorderDrawings(selectedDrawingIds, "forward"),
            sendBackward: () => reorderDrawings(selectedDrawingIds, "backward"),
            sendToBack: () => reorderDrawings(selectedDrawingIds, "back"),
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
                <input
                  type="color"
                  value={cat.color}
                  onChange={(e) =>
                    patchCategory(cat.code, { color: e.target.value })
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

// ── Host-Helfer ──────────────────────────────────────────────────────────────

/**
 * Baut den vollständigen Host-Wert für den Context, indem an den gemeinsamen
 * `base` der zum aktiven Tab des Docks gehörende Darstellungsmodus angehängt
 * wird. So liest das gerade gerenderte Panel über `usePanelHost().displayMode`
 * genau seinen Modus. Rückgabe als `PanelHost` (Record), das der Context
 * erwartet — die Verengung auf `PanelHostValue` macht `usePanelHost`.
 */
function hostWithMode(
  base: Omit<PanelHostValue, "displayMode">,
  activeTab: string | null,
  modeFor: (id: string | null) => DisplayMode,
  setModeFor: (id: string | null, mode: DisplayMode) => void,
  measurement: MeasurementReadout | null = null,
): PanelHost {
  const value: PanelHostValue = {
    ...base,
    // Live-Messwerte NICHT aus dem memoisierten `base` (dort wären sie eingefroren,
    // da `draft` bewusst kein Memo-Dep ist — sonst würde der ganze Host bei jeder
    // Mausbewegung neu gebaut). Hier bei jedem Render frisch injiziert.
    measurement,
    displayMode: {
      mode: modeFor(activeTab),
      setMode: (mode) => setModeFor(activeTab, mode),
    },
  };
  return value as unknown as PanelHost;
}

// ── Wand-Trefferprüfung im Modellraum (für das Grundriss-Kontextmenü) ────────

/**
 * Liefert die ID der obersten Wand, deren (gehrtes) Band den Modellpunkt
 * enthält — gefiltert auf das aktive Geschoss + sichtbare Kategorien, in
 * umgekehrter Wand-Reihenfolge (zuletzt gezeichnet zuerst). Spiegelt die
 * Trefferlogik der PlanView, arbeitet aber direkt auf den Wand-Polygonen, da
 * das Grundriss-Kontextmenü nur den Modellpunkt kennt. `null` bei Leerraum.
 */
function hitTestWall(
  project: Project,
  floorId: string,
  visibleCodes: Set<string>,
  m: Vec2,
): string | null {
  const walls = project.walls.filter(
    (w) => w.floorId === floorId && visibleCodes.has(w.categoryCode),
  );
  for (let i = walls.length - 1; i >= 0; i--) {
    const w = walls[i];
    const thickness = wallTypeThickness(getWallType(project, w));
    const corners = wallCorners(w.start, w.end, thickness);
    if (pointInPoly(m, corners)) return w.id;
  }
  return null;
}

/** Punkt-in-Polygon (Ray-Casting) im Modellraum — wie in der PlanView. */
function pointInPoly(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ── Kontextmenü-Aufbau (Einträge je Quelle) ──────────────────────────────────

/** Titel des Kontextmenüs je Quelle (Ebenenname/-code, Geschossname, „Wand"). */
function menuTitle(menu: NonNullable<MenuState>, project: Project): string {
  switch (menu.kind) {
    case "layer": {
      const c = findCategory(project.layers, menu.code);
      return c ? `${c.code} · ${c.name}` : menu.code;
    }
    case "level": {
      const l = project.drawingLevels.find((z) => z.id === menu.id);
      return l ? l.name : t("ctx.title.level");
    }
    case "plan":
    case "viewport":
      return menu.wallId ? t("ctx.title.wall") : t("ctx.title.view");
  }
}

/** Aktionen, die der Kontextmenü-Builder von App braucht (alle verdrahtet). */
interface MenuActions {
  project: Project;
  selectedWallId: string | null;
  layerClipboard: { color: string; lw: number } | null;
  openLayerEditor: (code: string) => void;
  openLevelEditor: (id: string) => void;
  addSubCategory: (parentCode: string) => void;
  assignWallCategory: (wallId: string, code: string) => void;
  duplicateCategory: (code: string) => void;
  deleteCategory: (code: string) => void;
  setLayerClipboard: (clip: { color: string; lw: number } | null) => void;
  patchCategory: (code: string, patch: Partial<LayerCategory>) => void;
  duplicateLevel: (id: string) => void;
  deleteLevel: (id: string) => void;
  clearSelection: () => void;
  fit: () => void;
  fitSelection: () => void;
  /** Anzahl geschlossener Flächen in der aktuellen 2D-Auswahl (Boolean-Aktivierung). */
  closedSelectionCount: number;
  union: () => void;
  difference: () => void;
  intersect: () => void;
  /** Anzahl aktuell selektierter 2D-Zeichnungselemente (z-Anordnen-Menü). */
  drawingSelectionCount: number;
  bringToFront: () => void;
  bringForward: () => void;
  sendBackward: () => void;
  sendToBack: () => void;
}

/**
 * Baut die Kontextmenü-Einträge je Quelle — 1:1 nach docs/design/context-menu.md.
 * JEDER Eintrag ist verdrahtet ODER klar deaktiviert mit Tooltip (`title`,
 * nennt den Grund) — kein stiller No-Op.
 */
function buildMenuItems(
  menu: NonNullable<MenuState>,
  a: MenuActions,
): ContextMenuItem[] {
  switch (menu.kind) {
    case "layer":
      return layerMenuItems(menu.code, a);
    case "level":
      return levelMenuItems(menu.id, a);
    case "plan":
      return planMenuItems(menu.wallId, a);
    case "viewport":
      return viewportMenuItems(menu.wallId, a);
  }
}

/** Ebenen-Kontextmenü (Rechtsklick auf Ebenen-Zeile). */
function layerMenuItems(code: string, a: MenuActions): ContextMenuItem[] {
  const total = flattenCategories(a.project.layers).length;
  const hasSelection = a.selectedWallId !== null;
  const hasClipboard = a.layerClipboard !== null;
  return [
    {
      label: t("ctx.layerSettings"),
      icon: <MenuIcon name="settings" />,
      onClick: () => a.openLayerEditor(code),
    },
    { divider: true },
    {
      label: t("ctx.addSubLayer"),
      icon: <MenuIcon name="add" />,
      onClick: () => a.addSubCategory(code),
    },
    {
      label: t("ctx.assignSelection"),
      icon: <MenuIcon name="move_down" />,
      disabled: !hasSelection,
      title: hasSelection ? undefined : t("ctx.assignSelection.disabled"),
      onClick: () => {
        if (a.selectedWallId) a.assignWallCategory(a.selectedWallId, code);
      },
    },
    { divider: true },
    {
      label: t("ctx.duplicate"),
      icon: <MenuIcon name="content_copy" />,
      onClick: () => a.duplicateCategory(code),
    },
    {
      label: t("ctx.copyProps"),
      icon: <MenuIcon name="colorize" />,
      onClick: () => {
        const c = findCategory(a.project.layers, code);
        if (c) a.setLayerClipboard({ color: c.color, lw: c.lw });
      },
    },
    {
      label: t("ctx.pasteProps"),
      icon: <MenuIcon name="format_paint" />,
      disabled: !hasClipboard,
      title: hasClipboard ? undefined : t("ctx.pasteProps.disabled"),
      onClick: () => {
        if (a.layerClipboard)
          a.patchCategory(code, {
            color: a.layerClipboard.color,
            lw: a.layerClipboard.lw,
          });
      },
    },
    { divider: true },
    {
      label: t("ctx.delete"),
      icon: <MenuIcon name="delete" />,
      danger: true,
      disabled: total <= 1,
      title: total <= 1 ? t("ctx.delete.lastLayer") : undefined,
      onClick: () => a.deleteCategory(code),
    },
  ];
}

/** Zeichnungsebenen-Kontextmenü (Rechtsklick auf Geschoss/Schnitt/Zeichnung). */
function levelMenuItems(id: string, a: MenuActions): ContextMenuItem[] {
  const total = a.project.drawingLevels.length;
  return [
    {
      label: t("ctx.levelSettings"),
      icon: <MenuIcon name="settings" />,
      onClick: () => a.openLevelEditor(id),
    },
    { divider: true },
    {
      label: t("ctx.duplicate"),
      icon: <MenuIcon name="content_copy" />,
      onClick: () => a.duplicateLevel(id),
    },
    { divider: true },
    {
      label: t("ctx.delete"),
      icon: <MenuIcon name="delete" />,
      danger: true,
      disabled: total <= 1,
      title: total <= 1 ? t("ctx.delete.lastLevel") : undefined,
      onClick: () => a.deleteLevel(id),
    },
  ];
}

/**
 * Grundriss-Kontextmenü. Bezug ist die getroffene/gewählte Wand. Einträge sind
 * verdrahtet: „Auf Auswahl einpassen" (PlanView-Handle) und „Auswahl aufheben".
 * Ohne getroffene Wand bleibt nur „Einpassen". (Eigenschaften-Panel/Bemaßung
 * folgen später — daher hier KEIN Schein-Eintrag.)
 */
function planMenuItems(
  wallId: string | null,
  a: MenuActions,
): ContextMenuItem[] {
  // Boolean-Einträge (Vereinigen/Subtrahieren/Schneiden) auf die 2D-Auswahl.
  // Aktiv ab 2 geschlossenen Flächen; sonst deaktiviert mit erklärendem Tooltip.
  const boolEnabled = a.closedSelectionCount >= 2;
  const boolTitle = boolEnabled ? undefined : t("ctx.boolean.disabled");
  const booleanItems: ContextMenuItem[] = [
    {
      label: t("ctx.union"),
      icon: <MenuIcon name="join_full" />,
      disabled: !boolEnabled,
      title: boolTitle,
      onClick: a.union,
    },
    {
      label: t("ctx.subtract"),
      icon: <MenuIcon name="join_left" />,
      disabled: !boolEnabled,
      title: boolTitle,
      onClick: a.difference,
    },
    {
      label: t("ctx.intersect"),
      icon: <MenuIcon name="join_inner" />,
      disabled: !boolEnabled,
      title: boolTitle,
      onClick: a.intersect,
    },
  ];

  // Z-Anordnen (nach vorn/hinten holen) — wirkt auf die aktuelle 2D-Auswahl,
  // sortiert `drawings2d` um (Array-Reihenfolge = Zeichenreihenfolge). Aktiv
  // ab 1 selektiertem Element; sonst deaktiviert mit erklärendem Tooltip.
  const arrangeEnabled = a.drawingSelectionCount >= 1;
  const arrangeTitle = arrangeEnabled ? undefined : t("ctx.arrange.disabled");
  const arrangeItems: ContextMenuItem[] = [
    {
      label: t("ctx.arrange.front"),
      icon: <MenuIcon name="flip_to_front" />,
      disabled: !arrangeEnabled,
      title: arrangeTitle,
      onClick: a.bringToFront,
    },
    {
      label: t("ctx.arrange.forward"),
      icon: <MenuIcon name="arrow_upward" />,
      disabled: !arrangeEnabled,
      title: arrangeTitle,
      onClick: a.bringForward,
    },
    {
      label: t("ctx.arrange.backward"),
      icon: <MenuIcon name="arrow_downward" />,
      disabled: !arrangeEnabled,
      title: arrangeTitle,
      onClick: a.sendBackward,
    },
    {
      label: t("ctx.arrange.back"),
      icon: <MenuIcon name="flip_to_back" />,
      disabled: !arrangeEnabled,
      title: arrangeTitle,
      onClick: a.sendToBack,
    },
  ];

  if (wallId) {
    return [
      {
        label: t("ctx.fitSelection"),
        icon: <MenuIcon name="center_focus_strong" />,
        onClick: a.fitSelection,
      },
      {
        label: t("ctx.clearSelection"),
        icon: <MenuIcon name="deselect" />,
        onClick: a.clearSelection,
      },
      { divider: true },
      ...booleanItems,
      { divider: true },
      ...arrangeItems,
      { divider: true },
      {
        label: t("ctx.fit"),
        icon: <MenuIcon name="fit_screen" />,
        onClick: a.fit,
      },
    ];
  }
  return [
    ...booleanItems,
    { divider: true },
    ...arrangeItems,
    { divider: true },
    {
      label: t("ctx.fit"),
      icon: <MenuIcon name="fit_screen" />,
      onClick: a.fit,
    },
  ];
}

/**
 * 3D-Kontextmenü. Im 3D gibt es (noch) kein Einpassen-Handle wie im Grundriss;
 * verdrahtet ist „Auswahl aufheben" (mit getroffener Wand). Ohne Wand ist das
 * Menü leer-sinnvoll: ein deaktivierter Hinweis, kein stiller No-Op.
 */
function viewportMenuItems(
  wallId: string | null,
  a: MenuActions,
): ContextMenuItem[] {
  if (wallId) {
    return [
      {
        label: t("ctx.clearSelection"),
        icon: <MenuIcon name="deselect" />,
        onClick: a.clearSelection,
      },
    ];
  }
  return [
    {
      label: t("ctx.noWallHit"),
      disabled: true,
      title: t("ctx.noWallHit.hint"),
    },
  ];
}

// ── Inline-Editor (Ebene / Geschoss) ─────────────────────────────────────────

/**
 * Kleiner schwebender Editor (dunkel, wie das Kontextmenü) am Anker. Schließt
 * über Außenklick / Esc. Rein darstellend: die Felder rufen die übergebenen
 * Patch-Handler, die live auf den State wirken (kein Bestätigen nötig).
 */
function InlineEditor({
  x,
  y,
  title,
  onClose,
  children,
}: {
  x: number;
  y: number;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // An die Viewport-Ränder klemmen (wie das Kontextmenü).
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 4) nx = window.innerWidth - r.width - 4;
    if (ny + r.height > window.innerHeight - 4)
      ny = window.innerHeight - r.height - 4;
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) });
  }, [x, y]);
  // Schließen bei Außenklick / Esc.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-editor"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={title}
    >
      <div className="ctx-editor-head">
        <span className="ctx-editor-title">{title}</span>
        <button
          className="ctx-editor-close"
          onClick={onClose}
          aria-label={t("editor.close")}
        >
          ×
        </button>
      </div>
      <div className="ctx-editor-body">{children}</div>
    </div>
  );
}

/** Eine Editor-Zeile: Beschriftung links, Steuerelement rechts. */
function EditorField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="editor-field">
      <span className="editor-label">{label}</span>
      <span className="editor-control">{children}</span>
    </label>
  );
}

// ── Layout-Menü (Oberleiste) ─────────────────────────────────────────────────

/**
 * Kleines Layout-Menü: aktuelles Layout unter einem Namen sichern und ein
 * gespeichertes Layout wählen (oder löschen). Liest die Namen frisch aus dem
 * localStorage, sobald das Menü geöffnet wird.
 */
function LayoutMenu({
  layout,
  onApply,
}: {
  layout: LayoutState;
  onApply: (layout: LayoutState) => void;
}) {
  const [names, setNames] = useState<string[]>([]);
  // Name-Erfassung über PromptDialog statt window.prompt (im Tauri-WKWebView
  // deaktiviert — liefert sofort null, nichts würde je gespeichert).
  const [saving, setSaving] = useState(false);

  const refresh = () => setNames(listNamedLayouts());

  const onSave = () => setSaving(true);
  const commitSave = (name: string) => {
    saveNamedLayout(name.trim(), layout);
    refresh();
    setSaving(false);
  };

  // Aktions-Menü (analog ComboMenu in TopBar.tsx): „Aktuelles speichern" oben,
  // dann je eine Gruppe „Laden" und „Löschen" (Trenner statt <optgroup>, die
  // die Dropdown-Komponente nicht kennt).
  const items: DropdownItem[] = [];
  items.push({ label: t("layout.saveCurrent"), onSelect: onSave });
  if (names.length > 0) {
    items.push({ divider: true });
    for (const n of names) {
      items.push({
        label: n,
        onSelect: () => {
          const loaded = loadNamedLayout(n);
          if (loaded) onApply(loaded);
        },
      });
    }
    items.push({ divider: true });
    for (const n of names) {
      items.push({
        label: `✕ ${n}`,
        danger: true,
        onSelect: () => {
          deleteNamedLayout(n);
          refresh();
        },
      });
    }
  }

  return (
    <span onPointerDownCapture={refresh}>
      <Dropdown items={items} placeholder={t("layout.placeholder")} title={t("layout.title")} />
      {saving && (
        <PromptDialog
          title={t("layout.title")}
          label={t("layout.savePrompt")}
          onConfirm={commitSave}
          onClose={() => setSaving(false)}
        />
      )}
    </span>
  );
}

// ── Inhalt (Mitte) ───────────────────────────────────────────────────────────

/** Hauptinhalt — abhängig von der aktiven Zeichnungsebene und dem Ansichtstyp. */
function Content({
  project,
  level,
  viewType,
  visibleCodes,
  detail,
  referenceLines,
  hairline,
  marqueeColor,
  snapColor,
  renderMode,
  view3d,
  fov,
  grid3dVisible,
  onToggleGrid3d,
  mono,
  drawings,
  onSelectLevel,
  floorDisplay,
  categoryDisplay,
  displayKey,
  planViewRef,
  onCursor,
  onScale,
  selectedWallIds,
  selectedCeilingIds,
  selectedOpeningIds,
  selectedStairIds,
  selectedExtrudedSolidIds,
  selectedColumnIds,
  selectedRoomIds,
  selectedRoofIds,
  roomStamp,
  onStampMove,
  onStampEdit,
  onEditDrawingText,
  onPlanSelect,
  onPlanMarquee,
  onSegmentCut,
  onPlanContextMenu,
  onViewportSelectWall,
  onViewportSelectCeiling,
  onViewportSelectOpening,
  onViewportSelectStair,
  onViewportContextMenu,
  onViewport3dPick,
  commandActive,
  draft,
  onWorkplanePoint,
  onWorkplaneConfirm,
  activeTool,
  toolInputActive,
  toolHandlers,
  grips,
  edgeGrips,
  selectedDrawingId,
  selectedDrawingIds,
  gripHandlers,
  edit3dWalls,
  edit3dDrawings,
  edit3dCeilings,
  edit3dRoofs,
  onEdit3dVertex,
  onEdit3dBody,
  onEdit3dEdge,
  onEdit3dRoofPitch,
  onEdit3dWallTop,
  onEdit3dEnd,
}: {
  project: Project;
  level: DrawingLevel;
  viewType: ViewType;
  visibleCodes: Set<string>;
  detail: DetailLevel;
  referenceLines: boolean;
  hairline: boolean;
  /** Farbe des Auswahlrahmens (Marquee) im Grundriss. */
  marqueeColor: string;
  /** Farbe der Snap-/Endpunkt-Hervorhebung im Grundriss. */
  snapColor: string;
  renderMode: RenderMode;
  /** Kanonischer 3D-Blickwinkel (Preset) der Perspektive. */
  view3d: View3d;
  /** Sichtwinkel der 3D-Perspektivkamera in Grad. */
  fov: number;
  /** Boden-Referenzraster im 3D-Viewport sichtbar (wirkt nur im WASM-Pfad). */
  grid3dVisible: boolean;
  /** Klick auf den Grid-Umschalter-Button im 3D-Viewport (WASM-Pfad). */
  onToggleGrid3d: () => void;
  /** Grundriss in Schwarz-Weiss (mono) statt mit Kategorie-/Element-Farben. */
  mono: boolean;
  /** Dokument-Tabs der Kopfzeile — ein Tab je Geschoss-Grundriss. */
  drawings: Drawing[];
  /** Aktiviert eine Zeichnungsebene (Geschoss) — geteilt mit dem Panel
   *  „Zeichnungsebenen"; siehe DrawingTabs.tsx. */
  onSelectLevel: (id: string) => void;
  floorDisplay: DisplayResolver;
  categoryDisplay: CategoryDisplayResolver & DisplayResolver;
  displayKey: string;
  planViewRef: React.RefObject<PlanViewHandle>;
  onCursor: (model: Vec2 | null) => void;
  onScale: (n: number) => void;
  selectedWallIds: string[];
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedExtrudedSolidIds: string[];
  selectedColumnIds: string[];
  selectedRoomIds: string[];
  selectedRoofIds: string[];
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
  onStampEdit: (roomId: string) => void;
  onEditDrawingText?: (drawingId: string) => void;
  onPlanSelect: (sel: PlanSelection) => void;
  onPlanMarquee: (sel: MarqueeSelection) => void;
  onSegmentCut: (drawingId: string, model: Vec2) => void;
  onPlanContextMenu: (info: {
    clientX: number;
    clientY: number;
    model: Vec2;
  }) => void;
  onViewportSelectWall: (wallId: string | null) => void;
  onViewportSelectCeiling: (ceilingId: string | null) => void;
  onViewportSelectOpening: (openingId: string | null) => void;
  onViewportSelectStair: (stairId: string | null) => void;
  onViewportContextMenu: (info: ViewportContextInfo) => void;
  /** Links-KLICK-Auswahl im WASM-3D-Viewport (TS-Raycast, Wand/Decke). */
  onViewport3dPick: (hit: Pick3dHit, additive: boolean) => void;
  /** Läuft ein zeichnender Befehl? Macht den 3D-Viewport zur Erstellungs-Fläche. */
  commandActive: boolean;
  /** Aktuelle Werkzeug-Vorschau (Rubber-Band) — auch in 3D gespiegelt. */
  draft: ToolDraft | null;
  /** Auf die Arbeitsebene projizierter Punkt → CommandEngine (move/pick). */
  onWorkplanePoint: (kind: "move" | "pick", model: Vec2) => void;
  /** Befehl bestätigen/beenden aus dem 3D-Viewport. */
  onWorkplaneConfirm: () => void;
  activeTool: ToolId;
  toolInputActive: boolean;
  toolHandlers: ToolHandlers;
  grips: Vec2[];
  edgeGrips: EdgeGrip[];
  selectedDrawingId: string | null;
  selectedDrawingIds?: string[];
  gripHandlers: GripHandlers;
  /** Alle gewählten Wände — Quelle der 3D-Editier-Griffe (Mehrfachauswahl ⇒ alle). */
  edit3dWalls: Wall[];
  /** Alle gewählten 2D-Elemente — 3D-Vertex-Griffe (Mehrfachauswahl ⇒ alle). */
  edit3dDrawings: Drawing2D[];
  /** Alle gewählten Decken — 3D-Eckpunkt-/Kanten-/Verschiebe-Griffe. */
  edit3dCeilings: Ceiling[];
  edit3dRoofs: Roof[];
  onEdit3dVertex: (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    index: number,
    model: Vec2,
    excludeWallIds?: Set<string>,
    excludeDrawingIds?: Set<string>,
  ) => Vec2;
  onEdit3dBody: (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    delta: Vec2,
  ) => void;
  onEdit3dEdge: (ceilingId: string, aIndex: number, bIndex: number, delta: Vec2) => void;
  onEdit3dRoofPitch: (roofId: string, apexHeight: number) => void;
  onEdit3dWallTop: (wallId: string, topZ: number) => void;
  onEdit3dEnd: () => void;
}) {
  // Auswahl-Hervorhebung im WASM-3D-Viewport: Umriss der gewählten Wand(e)/
  // Decke(n) in Akzent-Orange, immer obenauf (s. selectionHighlightLines in
  // plan/toWalls3d.ts + set_highlight_lines in useWasm3dRenderer). Wirkt NUR
  // im WASM-Zweig (Viewport3D reicht sie nur dort an Wasm3DViewport durch);
  // die three.js-Sicht hebt die Auswahl weiterhin über ihr eigenes Material
  // hervor. Leere Auswahl → null (kein Highlight).
  const highlightLines = useMemo(
    () =>
      selectedWallIds.length === 0 &&
      selectedCeilingIds.length === 0 &&
      selectedOpeningIds.length === 0 &&
      selectedStairIds.length === 0 &&
      selectedRoofIds.length === 0
        ? null
        : selectionHighlightLines(
            project,
            selectedWallIds,
            selectedCeilingIds,
            HIGHLIGHT_RGB,
            selectedOpeningIds,
            selectedStairIds,
            selectedRoofIds,
          ),
    [
      project,
      selectedWallIds,
      selectedCeilingIds,
      selectedOpeningIds,
      selectedStairIds,
      selectedRoofIds,
    ],
  );

  if (level.kind === "section" || level.kind === "elevation") {
    return (
      <main className="content">
        <DrawingTabs
          drawings={drawings}
          activeLevelId={level.id}
          onSelectLevel={onSelectLevel}
        />
        <SectionPlanView
          project={project}
          level={level}
          hairline={hairline}
          marqueeColor={marqueeColor}
          snapColor={snapColor}
          mono={mono}
          planViewRef={planViewRef}
          onCursor={onCursor}
          onScale={onScale}
          selectedWallIds={selectedWallIds}
          selectedCeilingIds={selectedCeilingIds}
          selectedOpeningIds={selectedOpeningIds}
          selectedStairIds={selectedStairIds}
          selectedExtrudedSolidIds={selectedExtrudedSolidIds}
          selectedColumnIds={selectedColumnIds}
          selectedRoomIds={selectedRoomIds}
          selectedRoofIds={selectedRoofIds}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
          onEditDrawingText={onEditDrawingText}
          onPlanSelect={onPlanSelect}
          onPlanMarquee={onPlanMarquee}
          onSegmentCut={onSegmentCut}
          onPlanContextMenu={onPlanContextMenu}
          activeTool={activeTool}
          toolInputActive={toolInputActive}
          toolHandlers={toolHandlers}
          grips={grips}
          edgeGrips={edgeGrips}
          selectedDrawingId={selectedDrawingId}
          selectedDrawingIds={selectedDrawingIds}
          gripHandlers={gripHandlers}
        />
      </main>
    );
  }

  // Freie Zeichnung: dieselbe Plan-Ansicht wie ein Geschoss (generatePlan filtert
  // `drawings2d` nach `level.id`), nur OHNE Geschoss-Eigenschaftsleiste und ohne
  // 3D-Umschaltung — eine Zeichnung hat keine Höhe/3D. So sind importierte
  // DXF-Polylinien hier sofort sichtbar und mit den 2D-Werkzeugen bearbeitbar.
  if (level.kind === "drawing") {
    return (
      <main className="content">
        <DrawingTabs
          drawings={drawings}
          activeLevelId={level.id}
          onSelectLevel={onSelectLevel}
        />
        <LevelPlanView
          project={project}
          level={level}
          visibleCodes={visibleCodes}
          categoryDisplay={categoryDisplay}
          detail={detail}
          referenceLines={referenceLines}
          hairline={hairline}
          marqueeColor={marqueeColor}
          snapColor={snapColor}
          mono={mono}
          planViewRef={planViewRef}
          onCursor={onCursor}
          onScale={onScale}
          selectedWallIds={selectedWallIds}
          selectedCeilingIds={selectedCeilingIds}
          selectedOpeningIds={selectedOpeningIds}
          selectedStairIds={selectedStairIds}
          selectedExtrudedSolidIds={selectedExtrudedSolidIds}
          selectedColumnIds={selectedColumnIds}
          selectedRoomIds={selectedRoomIds}
          selectedRoofIds={selectedRoofIds}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
          onEditDrawingText={onEditDrawingText}
          onPlanSelect={onPlanSelect}
          onPlanMarquee={onPlanMarquee}
          onSegmentCut={onSegmentCut}
          onPlanContextMenu={onPlanContextMenu}
          activeTool={activeTool}
          toolInputActive={toolInputActive}
          toolHandlers={toolHandlers}
          grips={grips}
          edgeGrips={edgeGrips}
          selectedDrawingId={selectedDrawingId}
          selectedDrawingIds={selectedDrawingIds}
          gripHandlers={gripHandlers}
        />
      </main>
    );
  }

  // Geschoss: Dokument-Tabs + gewählte Ansicht. Geschosshöhe/Schnitthöhe
  // werden in den Geschoss-Einstellungen gepflegt (Rechtsklick auf das
  // Geschoss im Panel „Zeichnungsebenen"), nicht mehr hier in der Kopfzeile.
  return (
    <main className="content">
      <DrawingTabs
        drawings={drawings}
        activeLevelId={level.id}
        onSelectLevel={onSelectLevel}
      />
      {viewType === "perspektive" ? (
        <section className="pane">
          <div className="pane-title">
            {t("content.perspektiveTitle", { name: level.name })}
          </div>
          <Viewport3D
            project={project}
            visibleCodes={visibleCodes}
            floorDisplay={floorDisplay}
            categoryDisplay={categoryDisplay}
            displayKey={displayKey}
            renderMode={renderMode}
            detail={detail}
            view3d={view3d}
            fov={fov}
            gridElevation={level.baseElevation ?? 0}
            gridVisible={grid3dVisible}
            onToggleGrid={onToggleGrid3d}
            onSelectWall={onViewportSelectWall}
            onSelectCeiling={onViewportSelectCeiling}
            onSelectOpening={onViewportSelectOpening}
            onSelectStair={onViewportSelectStair}
            onContextMenu={onViewportContextMenu}
            onPick3d={onViewport3dPick}
            highlightLines={highlightLines}
            commandActive={commandActive}
            draft={draft}
            onWorkplanePoint={onWorkplanePoint}
            onWorkplaneConfirm={onWorkplaneConfirm}
            editWalls={edit3dWalls}
            editDrawings={edit3dDrawings}
            editCeilings={edit3dCeilings}
            editRoofs={edit3dRoofs}
            onEditVertex={onEdit3dVertex}
            onEditBody={onEdit3dBody}
            onEditEdge={onEdit3dEdge}
            onEditRoofPitch={onEdit3dRoofPitch}
            onEditWallTop={onEdit3dWallTop}
            onEditEnd={onEdit3dEnd}
          />
        </section>
      ) : (
        <LevelPlanView
          project={project}
          level={level}
          visibleCodes={visibleCodes}
          categoryDisplay={categoryDisplay}
          detail={detail}
          referenceLines={referenceLines}
          hairline={hairline}
          marqueeColor={marqueeColor}
          snapColor={snapColor}
          mono={mono}
          planViewRef={planViewRef}
          onCursor={onCursor}
          onScale={onScale}
          selectedWallIds={selectedWallIds}
          selectedCeilingIds={selectedCeilingIds}
          selectedOpeningIds={selectedOpeningIds}
          selectedStairIds={selectedStairIds}
          selectedExtrudedSolidIds={selectedExtrudedSolidIds}
          selectedColumnIds={selectedColumnIds}
          selectedRoomIds={selectedRoomIds}
          selectedRoofIds={selectedRoofIds}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
          onEditDrawingText={onEditDrawingText}
          onPlanSelect={onPlanSelect}
          onPlanMarquee={onPlanMarquee}
          onSegmentCut={onSegmentCut}
          onPlanContextMenu={onPlanContextMenu}
          activeTool={activeTool}
          toolInputActive={toolInputActive}
          toolHandlers={toolHandlers}
          grips={grips}
          edgeGrips={edgeGrips}
          selectedDrawingId={selectedDrawingId}
          selectedDrawingIds={selectedDrawingIds}
          gripHandlers={gripHandlers}
        />
      )}
    </main>
  );
}

/** Abgeleiteter Grundriss eines Geschosses. */
function LevelPlanView({
  project,
  level,
  visibleCodes,
  categoryDisplay,
  detail,
  referenceLines,
  hairline,
  marqueeColor,
  snapColor,
  mono,
  planViewRef,
  onCursor,
  onScale,
  selectedWallIds,
  selectedCeilingIds,
  selectedOpeningIds,
  selectedStairIds,
  selectedExtrudedSolidIds,
  selectedColumnIds,
  selectedRoomIds,
  selectedRoofIds,
  roomStamp,
  onStampMove,
  onStampEdit,
  onEditDrawingText,
  onPlanSelect,
  onPlanMarquee,
  onSegmentCut,
  onPlanContextMenu,
  activeTool,
  toolInputActive,
  toolHandlers,
  grips,
  edgeGrips,
  selectedDrawingId,
  selectedDrawingIds,
  gripHandlers,
}: {
  project: Project;
  level: DrawingLevel;
  visibleCodes: Set<string>;
  categoryDisplay: CategoryDisplayResolver;
  detail: DetailLevel;
  referenceLines: boolean;
  hairline: boolean;
  marqueeColor: string;
  snapColor: string;
  mono: boolean;
  planViewRef: React.RefObject<PlanViewHandle>;
  onCursor: (model: Vec2 | null) => void;
  onScale: (n: number) => void;
  selectedWallIds: string[];
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedExtrudedSolidIds: string[];
  selectedColumnIds: string[];
  selectedRoomIds: string[];
  selectedRoofIds: string[];
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
  onStampEdit: (roomId: string) => void;
  onEditDrawingText?: (drawingId: string) => void;
  onPlanSelect: (sel: PlanSelection) => void;
  onPlanMarquee: (sel: MarqueeSelection) => void;
  onSegmentCut: (drawingId: string, model: Vec2) => void;
  onPlanContextMenu: (info: {
    clientX: number;
    clientY: number;
    model: Vec2;
  }) => void;
  activeTool: ToolId;
  toolInputActive: boolean;
  toolHandlers: ToolHandlers;
  grips: Vec2[];
  edgeGrips: EdgeGrip[];
  selectedDrawingId: string | null;
  selectedDrawingIds?: string[];
  gripHandlers: GripHandlers;
}) {
  // Detailgrad + Referenzlinien fließen in die Plan-Erzeugung ein (Symbole,
  // Schraffuren/Linienfeinheit bzw. Wand-Achslinien).
  const plan = useMemo(
    () =>
      generatePlan(
        project,
        level.id,
        visibleCodes,
        categoryDisplay,
        detail,
        referenceLines,
        mono,
      ),
    [project, level.id, visibleCodes, categoryDisplay, detail, referenceLines, mono],
  );

  // Live-Spiegelung in die nativen wgpu-Fenster (No-op ohne Tauri, debounced):
  // EXAKT der sichtbare Plan (gleiches Geschoss, gleicher Detailgrad) fürs
  // 2D-Fenster, die Projekt-Wände fürs 3D-Fenster.
  useEffect(() => {
    pushNativeScene(plan);
  }, [plan]);
  useEffect(() => {
    pushNativeWalls(project);
  }, [project]);

  // Bei einer freien Zeichnung gibt es keine Schnitthöhe → eigene Legende/Titel.
  const isDrawing = level.kind === "drawing";
  const caption = isDrawing
    ? t("content.drawingLegend")
    : t("content.grundrissLegend", {
        name: level.name,
        cutHeight: formatM(level.cutHeight ?? 0),
      });

  return (
    <section className="pane">
      <div className="pane-title">
        {isDrawing
          ? t("content.drawingTitle", { name: level.name })
          : t("content.grundrissTitle", { name: level.name })}
      </div>
      <PlanView
        ref={planViewRef}
        plan={plan}
        resetKey={level.id}
        onCursor={onCursor}
        onScale={onScale}
        selectedWallIds={selectedWallIds}
        selectedCeilingIds={selectedCeilingIds}
        selectedOpeningIds={selectedOpeningIds}
        selectedStairIds={selectedStairIds}
        selectedExtrudedSolidIds={selectedExtrudedSolidIds}
        selectedColumnIds={selectedColumnIds}
        selectedRoomIds={selectedRoomIds}
        selectedRoofIds={selectedRoofIds}
        roomStamp={roomStamp}
        onStampMove={onStampMove}
        onStampEdit={onStampEdit}
        onEditDrawingText={onEditDrawingText}
        onSelect={onPlanSelect}
        onMarquee={onPlanMarquee}
        onSegmentCut={onSegmentCut}
        onContextMenu={onPlanContextMenu}
        activeTool={activeTool}
        toolInputActive={toolInputActive}
        toolHandlers={toolHandlers}
        grips={grips}
        edgeGrips={edgeGrips}
        hairline={hairline}
        marqueeColor={marqueeColor}
        snapColor={snapColor}
        selectedDrawingId={selectedDrawingId}
        selectedDrawingIds={selectedDrawingIds}
        gripHandlers={gripHandlers}
      />
      <div className="plan-legend">{caption}</div>
    </section>
  );
}

/**
 * Schnitt-/Ansichts-Ebene: der render3d-Schnitt-Extraktor (WASM, plan/toSection)
 * durchschneidet das Modell entlang der Schnittlinie der Ebene und übersetzt das
 * Ergebnis (Cut-Polygone + sichtbare/verdeckte Kanten) über generateSectionPlan
 * in Plan-Primitive, die dieselbe PlanView wie ein Grundriss zeichnet.
 *
 * Die Berechnung ist asynchron (WASM lazy geladen); bis das Ergebnis da ist,
 * bzw. wenn die Ebene keine Schnittlinie trägt oder das WASM-Modul den Export
 * (noch) nicht kennt, wird ein Hinweis eingeblendet.
 */
function SectionPlanView({
  project,
  level,
  hairline,
  marqueeColor,
  snapColor,
  mono,
  planViewRef,
  onCursor,
  onScale,
  selectedWallIds,
  selectedCeilingIds,
  selectedOpeningIds,
  selectedStairIds,
  selectedExtrudedSolidIds,
  selectedColumnIds,
  selectedRoomIds,
  selectedRoofIds,
  roomStamp,
  onStampMove,
  onStampEdit,
  onEditDrawingText,
  onPlanSelect,
  onPlanMarquee,
  onSegmentCut,
  onPlanContextMenu,
  activeTool,
  toolInputActive,
  toolHandlers,
  grips,
  edgeGrips,
  selectedDrawingId,
  selectedDrawingIds,
  gripHandlers,
}: {
  project: Project;
  level: DrawingLevel;
  hairline: boolean;
  marqueeColor: string;
  snapColor: string;
  mono: boolean;
  planViewRef: React.RefObject<PlanViewHandle>;
  onCursor: (model: Vec2 | null) => void;
  onScale: (n: number) => void;
  selectedWallIds: string[];
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedExtrudedSolidIds: string[];
  selectedColumnIds: string[];
  selectedRoomIds: string[];
  selectedRoofIds: string[];
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
  onStampEdit: (roomId: string) => void;
  onEditDrawingText?: (drawingId: string) => void;
  onPlanSelect: (sel: PlanSelection) => void;
  onPlanMarquee: (sel: MarqueeSelection) => void;
  onSegmentCut: (drawingId: string, model: Vec2) => void;
  onPlanContextMenu: (info: { clientX: number; clientY: number; model: Vec2 }) => void;
  activeTool: ToolId;
  toolInputActive: boolean;
  toolHandlers: ToolHandlers;
  grips: Vec2[];
  edgeGrips: EdgeGrip[];
  selectedDrawingId: string | null;
  selectedDrawingIds?: string[];
  gripHandlers: GripHandlers;
}) {
  const [output, setOutput] = useState<SectionOutput | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">(
    "loading",
  );

  useEffect(() => {
    let disposed = false;
    setStatus("loading");
    setOutput(null);
    void (async () => {
      try {
        const out = await computeSection(project, level);
        if (disposed) return;
        if (!out) {
          setStatus("empty");
          return;
        }
        setOutput(out);
        setStatus("ready");
      } catch (e) {
        console.warn("render3d-Schnitt fehlgeschlagen:", e);
        if (!disposed) setStatus("error");
      }
    })();
    return () => {
      disposed = true;
    };
  }, [project, level]);

  const plan = useMemo(
    () => (output ? generateSectionPlan(output, mono) : null),
    [output, mono],
  );

  const kindLabel = level.kind === "section" ? t("stub.section") : t("stub.elevation");

  if (!plan || status !== "ready") {
    const note =
      status === "empty"
        ? t("section.empty", { kind: kindLabel })
        : status === "error"
          ? t("section.error", { kind: kindLabel })
          : t("section.loading", { kind: kindLabel });
    return (
      <div className="placeholder">
        <strong>{level.name}</strong>
        <span>{note}</span>
      </div>
    );
  }

  return (
    <section className="pane">
      <div className="pane-title">
        {t("content.sectionTitle", { name: level.name, kind: kindLabel })}
      </div>
      <PlanView
        ref={planViewRef}
        plan={plan}
        resetKey={level.id}
        onCursor={onCursor}
        onScale={onScale}
        selectedWallIds={selectedWallIds}
        selectedCeilingIds={selectedCeilingIds}
        selectedOpeningIds={selectedOpeningIds}
        selectedStairIds={selectedStairIds}
        selectedExtrudedSolidIds={selectedExtrudedSolidIds}
        selectedColumnIds={selectedColumnIds}
        selectedRoomIds={selectedRoomIds}
        selectedRoofIds={selectedRoofIds}
        roomStamp={roomStamp}
        onStampMove={onStampMove}
        onStampEdit={onStampEdit}
        onEditDrawingText={onEditDrawingText}
        onSelect={onPlanSelect}
        onMarquee={onPlanMarquee}
        onSegmentCut={onSegmentCut}
        onContextMenu={onPlanContextMenu}
        activeTool={activeTool}
        toolInputActive={toolInputActive}
        toolHandlers={toolHandlers}
        grips={grips}
        edgeGrips={edgeGrips}
        hairline={hairline}
        marqueeColor={marqueeColor}
        snapColor={snapColor}
        selectedDrawingId={selectedDrawingId}
        selectedDrawingIds={selectedDrawingIds}
        gripHandlers={gripHandlers}
      />
      <div className="plan-legend">{t("section.legend", { kind: kindLabel })}</div>
    </section>
  );
}
