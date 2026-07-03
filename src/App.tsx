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
import { leftNormal, normalize, scale, sub } from "./model/geometry";
import type {
  CeilingType,
  Drawing2D,
  DrawingLevel,
  EdgeGrip,
  LayerCategory,
  Project,
  Vec2,
  Wall,
  WallType,
} from "./model/types";
import { generatePlan, generateSectionPlan } from "./plan/generatePlan";
import type { CategoryDisplayResolver } from "./plan/generatePlan";
import { computeSection } from "./plan/toSection";
import type { SectionOutput } from "./plan/toSection";
import { pushNativeScene, pushNativeWalls } from "./plan/nativeSync";
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
import { PlanView } from "./plan/PlanView";
import type {
  PlanViewHandle,
  PlanSelection,
  MarqueeSelection,
  GripHandlers,
} from "./plan/PlanView";
import { Viewport3D } from "./viewport/Viewport3D";
import type { DisplayResolver, ViewportContextInfo } from "./viewport/Viewport3D";
import { ResourceManager } from "./ui/ResourceManager";
import type { ResourceManagerHandlers } from "./ui/ResourceManager";
import { TopBar } from "./ui/TopBar";
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
import { docFromText } from "./text/richText";
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
};
/** Befehlsname für ein gekoppeltes Werkzeug (oder null, wenn keiner). */
function coupledCommandFor(id: ToolId): string | null {
  return TOOL_COMMAND[id] ?? null;
}

/** Fragt die Kopienanzahl (≥1) für die Modi O/P ab; null bei Abbruch/ungültig. */
function promptCount(): number | null {
  const s = window.prompt(t("transform.countPrompt"), "3");
  if (s == null) return null;
  const n = Math.round(Number(s));
  return Number.isFinite(n) && n >= 1 ? n : null;
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
  const activeLevelId = useStore((s) => s.activeLevelId);
  const setActiveLevelId = useStore((s) => s.setActiveLevelId);
  const viewType = useStore((s) => s.viewType);
  const setViewType = useStore((s) => s.setViewType);

  // Schwebendes Ressourcen-Fenster (Overlay über allem). Transienter UI-State,
  // bleibt lokal. Wird über die Oberleiste geöffnet und über X / Hintergrund-
  // Klick / Esc geschlossen.
  const [resourcesOpen, setResourcesOpen] = useState(false);

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
  const planColorMode = useStore((s) => s.planColorMode);
  const setPlanColorMode = useStore((s) => s.setPlanColorMode);
  const referenceLines = useStore((s) => s.referenceLines);
  const setReferenceLines = useStore((s) => s.setReferenceLines);
  const lineMode = useStore((s) => s.lineMode);
  const setLineMode = useStore((s) => s.setLineMode);
  const scaleDenominator = useStore((s) => s.scaleDenominator);
  const setScaleDenominator = useStore((s) => s.setScaleDenominator);
  // LIVE Papier-Massstab-Nenner aus der View-Transform (PlanView meldet ihn);
  // null = keine Plan-Ansicht aktiv. Transienter UI-State, bleibt lokal.
  const [liveScale, setLiveScale] = useState<number | null>(null);
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
  // Bequemer Einzel-Selektor (erste gewählte Wand).
  const selectedWallId = selectedWallIds[0] ?? null;
  // Decken-Auswahl (MENGE); für die Einzel-Element-Maschinerie der „eine"
  // gewählte (bei genau einem Element).
  const selectedCeilingIds = useStore((s) => s.selectedCeilingIds);
  const setSelectedCeilingIds = useStore((s) => s.setSelectedCeilingIds);
  const selectedCeilingId =
    selectedCeilingIds.length === 1 ? selectedCeilingIds[0] : null;
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
  const transformSel: TransformSelection = {
    wallIds: selectedWallIds,
    drawingId: selectedDrawingId,
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
  const grips: Vec2[] = useMemo(() => {
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
    selectedWallIds,
    selectedDrawingId,
    project.walls,
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
    onMoveBody: (delta: Vec2, target?: { wallId?: string; drawingId?: string }) => {
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
    //    zur Kante (Seite verschiebt sich parallel nach außen/innen), aufs Raster
    //    gerundet — wie bisher.
    onEdgeMove: (edge: EdgeGrip, raw: Vec2, _pxPerMeter: number, mods: ToolMods) => {
      if (edge.free) {
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
      // Senkrechte Projektion von (raw − Grab-Mittelpunkt) auf die Außennormale.
      const rel = sub(raw, edge.mid);
      let offset = rel.x * edge.normal.x + rel.y * edge.normal.y;
      // Raster-Schritt (Snap) anwenden, sofern Snap+Raster aktiv und nicht per
      // Ctrl unterdrückt sind.
      const step = snap.gridSize;
      if (!mods.ctrl && snap.enabled && snap.grid && step > 0) {
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
      setDraft({ preview: [], vertices: [], snap: null });
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
        if (
          wallIds.length ||
          drawingIds.length ||
          ceilingIds.length ||
          stairIds.length ||
          roomIds.length
        ) {
          setSelectedWallIds(wallIds);
          setSelectedDrawingIds(drawingIds);
          setSelectedCeilingIds(ceilingIds);
          setSelectedStairIds(stairIds);
          setSelectedRoomIds(roomIds);
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
        selectedRoomIds.length
      ) {
        const dids = new Set(selectedDrawingIds);
        const wids = new Set(selectedWallIds);
        const cids = new Set(selectedCeilingIds);
        const oids = new Set(selectedOpeningIds);
        const stids = new Set(selectedStairIds);
        const rmids = new Set(selectedRoomIds);
        setProject((p) => ({
          ...p,
          drawings2d: p.drawings2d.filter((d) => !dids.has(d.id)),
          walls: p.walls.filter((w) => !wids.has(w.id)),
          ceilings: (p.ceilings ?? []).filter((c) => !cids.has(c.id)),
          stairs: (p.stairs ?? []).filter((s) => !stids.has(s.id)),
          rooms: (p.rooms ?? []).filter((r) => !rmids.has(r.id)),
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
    project.walls,
    project.drawings2d,
    project.ceilings,
    project.stairs,
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
          const n = promptCount();
          if (n) setActiveTransform((t) => (t ? { ...t, copyMode: "array", count: n } : t));
        } else if (k === "p") {
          const n = promptCount();
          if (n) setActiveTransform((t) => (t ? { ...t, copyMode: "distribute", count: n } : t));
        } else if (e.key === "Escape") {
          setActiveTransform(null);
          setDraft(null);
        } else return;
        e.preventDefault();
        return;
      }
      const hasSel = selectedWallIds.length > 0 || !!selectedDrawingId;
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
  }, [activeTool, activeTransform, selectedWallIds, selectedDrawingId, engine]);

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
  // Deckenstile: immutable Patch eines Deckentyps — analog `patchWallType`.
  const patchCeilingType = (id: string, patch: Partial<CeilingType>) =>
    setProject((p) => ({
      ...p,
      ceilingTypes: (p.ceilingTypes ?? []).map((ct) =>
        ct.id === id ? { ...ct, ...patch } : ct,
      ),
    }));
  const importLineStyles = useStore((s) => s.importLineStyles);
  const importHatches = useStore((s) => s.importHatches);
  // Site-/Kontext-Schicht (siteSlice): Import/Entfernen/Gelände.
  const addContextObjects = useStore((s) => s.addContextObjects);
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
  const textTarget = useMemo(
    () =>
      selectedRoom
        ? {
            doc: selectedRoom.stampDoc ?? docFromText(selectedRoom.name),
            range: null,
            apply: (doc: RichTextDoc) => setRoomStampDoc(selectedRoom.id, doc),
          }
        : null,
    [selectedRoom, setRoomStampDoc],
  );

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
    target: { wallId?: string; drawingId?: string },
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
    moveGripOf(target.drawingId ?? null, target.wallId ?? null, index, pt);
    return pt;
  };
  const onEdit3dBody = (target: { wallId?: string; drawingId?: string }, delta: Vec2) => {
    moveElementByOf(target.drawingId ?? null, target.wallId ?? null, delta);
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
      ),
    [project, selectedWallIds, selectedDrawingId, selectedCeilingId, selectedOpeningId, selectedStairId, selectedRoomId],
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

  // Bestätigte Import-Entscheidung ausführen: ggf. neue Zeichnung anlegen, die
  // 2D-Konturen als Drawing2D anhängen, optional die Meshes als Kontext
  // übernehmen. Reihenfolge: erst Ebene (echte ID), dann Drawings/Kontext.
  const runImport = (decision: ImportDecision) => {
    const levelId =
      decision.target.kind === "new"
        ? addDrawingLevel(decision.target.name)
        : decision.target.levelId;
    const drawings = buildDrawings(
      decision,
      levelId,
      project,
      activeCategoryCode,
    );
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
      onPatchCeilingType: patchCeilingType,
      onImportLineStyles: importLineStyles,
      onImportHatches: importHatches,
      selection,
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
        // Strichstärke gibt es als direktes Feld nur bei Drawing2D.
        if (selection?.kind === "drawing2d")
          setElementWeight(selection.id, weightMm);
      },
      onSetSelectionFill: (hatchId) => {
        // Füllschraffur nur bei Drawing2D (geschlossene Formen).
        if (selection?.kind === "drawing2d")
          setElementFill(selection.id, hatchId);
      },
      onSetSelectionFillColor: (color) => {
        // Vollton-Füllfarbe nur bei Drawing2D (geschlossene Formen).
        if (selection?.kind === "drawing2d")
          setElementFillColor(selection.id, color);
      },
      onResizeSelection: (w, h, anchor) => {
        if (selection?.kind === "wall" || selection?.kind === "drawing2d")
          resizeElement(selection.kind, selection.id, w, h, anchor);
      },
      // ── Wand-Attribute (nur bei selektierter Wand) ─────────────────────────
      onSetWallReferenceLine: (ref) => {
        if (selection?.kind === "wall")
          updateWall(selection.id, { referenceLine: ref });
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
      // ── Raum-Attribute (nur bei selektiertem Raum) ─────────────────────────
      onSetRoomName: (name) => {
        if (selection?.kind === "room") updateRoom(selection.id, { name });
      },
      onSetRoomSia: (category) => {
        if (selection?.kind === "room") updateRoom(selection.id, { siaCategory: category });
      },
      onEditRoomStamp: (roomId) => onOpenStampEditor(roomId),
      // ── Site-/Kontext-Schicht ──────────────────────────────────────────────
      contextObjects: project.context ?? [],
      onAddContextObjects: addContextObjects,
      onRemoveContextObject: removeContextObject,
      onGenerateTerrain: generateTerrain,
      onImportDxf: () => dxfInputRef.current?.click(),
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
    selection,
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
    onPatchCeilingType: patchCeilingType,
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
  };

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
  const rendererMode: RendererMode = (() => {
    const fromUrl = new URLSearchParams(window.location.search).get("engine");
    if (fromUrl === "wasm") return "wasm";
    if (fromUrl === "webgl2") return "webgl2";
    return window.localStorage.getItem(RENDERER_STORAGE_KEY) === "wasm"
      ? "wasm"
      : "webgl2";
  })();
  const webGpuAvailable = typeof navigator !== "undefined" && "gpu" in navigator;
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
      const n = promptCount();
      if (n) setActiveTransform((tr) => (tr ? { ...tr, copyMode: mode, count: n } : tr));
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
    setStampEditorRoomId(roomId);
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
      }
      return;
    }
    // Ohne Shift: ersetzen. Öffnung hat Vorrang (ihr Symbol liegt in der Lücke),
    // dann Wand, dann 2D-Element, dann Decke; sonst leeren. Die Kanäle schließen
    // sich gegenseitig aus.
    if (sel.openingId) {
      setSelectedOpeningIds([sel.openingId]);
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
    } else if (sel.wallId) {
      setSelectedWallIds([sel.wallId]);
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
    } else if (sel.drawingId) {
      setSelectedDrawingId(sel.drawingId);
      setSelectedWallIds([]);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
    } else if (sel.ceilingId) {
      setSelectedCeilingIds([sel.ceilingId]);
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
    } else if (sel.stairId) {
      setSelectedStairIds([sel.stairId]);
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedRoomIds([]);
    } else if (sel.roomId) {
      setSelectedRoomIds([sel.roomId]);
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
    } else {
      setSelectedWallIds([]);
      setSelectedDrawingId(null);
      setSelectedCeilingIds([]);
      setSelectedOpeningIds([]);
      setSelectedStairIds([]);
      setSelectedRoomIds([]);
    }
  };
  // Links-Drag (Marquee) im Grundriss: die getroffene Wand-MENGE übernehmen
  // (nach CAD-Konvention von PlanView bestimmt). Ersetzt die bisherige Auswahl.
  const onPlanMarquee = (sel: MarqueeSelection) => {
    setSelectedWallIds(sel.wallIds);
    setSelectedDrawingIds(sel.drawingIds ?? []);
    // Decken/Öffnungen/Treppen/Räume sind (noch) nicht Teil des Marquee → beim Aufziehen abwählen.
    setSelectedCeilingIds([]);
    setSelectedOpeningIds([]);
    setSelectedStairIds([]);
    setSelectedRoomIds([]);
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
    }
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
      <TopBar
        project={project}
        viewToggleEnabled={activeLevel.kind === "floor"}
        viewType={viewType}
        onViewType={setViewType}
        view3d={view3d}
        onView3d={setView3d}
        fov={fov}
        onFov={setFov}
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
        onExportPdf={() => setExportOpen(true)}
        onExportDxf={() => setExportDxfOpen(true)}
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
        resourcesOpen={resourcesOpen}
        onToggleResources={() => setResourcesOpen((v) => !v)}
        layoutMenu={
          <LayoutMenu
            layout={layout}
            onApply={(l) => setLayout(reconcileLayout(l))}
          />
        }
        textTarget={textTarget}
        onAddText={null}
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
              hostWithMode(baseHost, activeTab, modeFor, setModeFor)
            }
            displayModeFor={(activeTab) => modeFor(activeTab)}
            onDisplayModeChange={(activeTab, m) => setModeFor(activeTab, m)}
          />
        )}

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
          renderMode={renderMode}
          view3d={view3d}
          fov={fov}
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
          selectedRoomIds={selectedRoomIds}
          roomStamp={roomStamp}
          onStampMove={moveRoomStamp}
          onStampEdit={onOpenStampEditor}
          onPlanSelect={onPlanSelect}
          onPlanMarquee={onPlanMarquee}
          onSegmentCut={onSegmentCut}
          onPlanContextMenu={onPlanContextMenu}
          onViewportSelectWall={onViewportSelectWall}
          onViewportSelectCeiling={onViewportSelectCeiling}
          onViewportSelectOpening={onViewportSelectOpening}
          onViewportSelectStair={onViewportSelectStair}
          onViewportContextMenu={onViewportContextMenu}
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
          onEdit3dVertex={onEdit3dVertex}
          onEdit3dBody={onEdit3dBody}
          onEdit3dWallTop={onEdit3dWallTop}
          onEdit3dEnd={onEdit3dEnd}
        />

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
              hostWithMode(baseHost, activeTab, modeFor, setModeFor)
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
            value={hostWithMode(baseHost, fp.panelId, modeFor, setModeFor)}
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

      {/* Command-Line (Rhino-artig) ÜBER der Statusleiste: Prompt + klickbare
          Inline-Optionen + Texteingabe + Autocomplete. Tab fokussiert sie. */}
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
        rendererMode={rendererMode}
        webGpuAvailable={webGpuAvailable}
        onRendererModeChange={setRendererMode}
        lineMode={lineMode}
        onLineModeChange={setLineMode}
        lineModeEnabled={planActive}
        snap={snap}
        onSnapChange={setSnap}
      />

      {/* Schwebendes Ressourcen-Fenster ÜBER allem (hoher z-index, abgedunkelter
          Hintergrund). Schließt über X / Klick auf den Hintergrund / Esc. */}
      {resourcesOpen && (
        <ResourceManager
          project={project}
          handlers={resourceHandlers}
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
): PanelHost {
  const value: PanelHostValue = {
    ...base,
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

  const refresh = () => setNames(listNamedLayouts());

  const onSave = () => {
    const name = window.prompt(t("layout.savePrompt"));
    if (!name) return;
    saveNamedLayout(name.trim(), layout);
    refresh();
  };

  const onPick = (value: string) => {
    if (value === "__save__") {
      onSave();
      return;
    }
    if (value.startsWith("__del__:")) {
      const name = value.slice("__del__:".length);
      deleteNamedLayout(name);
      refresh();
      return;
    }
    const loaded = loadNamedLayout(value);
    if (loaded) onApply(loaded);
  };

  return (
    <select
      className="layout-menu"
      title={t("layout.title")}
      aria-label={t("layout.title")}
      value=""
      onFocus={refresh}
      onMouseDown={refresh}
      onChange={(e) => {
        onPick(e.target.value);
        // Auswahl-Anzeige zurücksetzen (Menü ist ein Aktions-Trigger).
        e.currentTarget.value = "";
      }}
    >
      <option value="" disabled>
        {t("layout.placeholder")}
      </option>
      <option value="__save__">{t("layout.saveCurrent")}</option>
      {names.length > 0 && (
        <optgroup label={t("layout.loadGroup")}>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </optgroup>
      )}
      {names.length > 0 && (
        <optgroup label={t("layout.deleteGroup")}>
          {names.map((n) => (
            <option key={`del-${n}`} value={`__del__:${n}`}>
              ✕ {n}
            </option>
          ))}
        </optgroup>
      )}
    </select>
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
  renderMode,
  view3d,
  fov,
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
  selectedRoomIds,
  roomStamp,
  onStampMove,
  onStampEdit,
  onPlanSelect,
  onPlanMarquee,
  onSegmentCut,
  onPlanContextMenu,
  onViewportSelectWall,
  onViewportSelectCeiling,
  onViewportSelectOpening,
  onViewportSelectStair,
  onViewportContextMenu,
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
  onEdit3dVertex,
  onEdit3dBody,
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
  renderMode: RenderMode;
  /** Kanonischer 3D-Blickwinkel (Preset) der Perspektive. */
  view3d: View3d;
  /** Sichtwinkel der 3D-Perspektivkamera in Grad. */
  fov: number;
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
  selectedRoomIds: string[];
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
  onStampEdit: (roomId: string) => void;
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
  onEdit3dVertex: (
    target: { wallId?: string; drawingId?: string },
    index: number,
    model: Vec2,
    excludeWallIds?: Set<string>,
    excludeDrawingIds?: Set<string>,
  ) => Vec2;
  onEdit3dBody: (target: { wallId?: string; drawingId?: string }, delta: Vec2) => void;
  onEdit3dWallTop: (wallId: string, topZ: number) => void;
  onEdit3dEnd: () => void;
}) {
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
          mono={mono}
          planViewRef={planViewRef}
          onCursor={onCursor}
          onScale={onScale}
          selectedWallIds={selectedWallIds}
          selectedCeilingIds={selectedCeilingIds}
          selectedOpeningIds={selectedOpeningIds}
          selectedStairIds={selectedStairIds}
          selectedRoomIds={selectedRoomIds}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
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
          mono={mono}
          planViewRef={planViewRef}
          onCursor={onCursor}
          onScale={onScale}
          selectedWallIds={selectedWallIds}
          selectedCeilingIds={selectedCeilingIds}
          selectedOpeningIds={selectedOpeningIds}
          selectedStairIds={selectedStairIds}
          selectedRoomIds={selectedRoomIds}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
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
            view3d={view3d}
            fov={fov}
            gridElevation={level.baseElevation ?? 0}
            onSelectWall={onViewportSelectWall}
            onSelectCeiling={onViewportSelectCeiling}
            onSelectOpening={onViewportSelectOpening}
            onSelectStair={onViewportSelectStair}
            onContextMenu={onViewportContextMenu}
            commandActive={commandActive}
            draft={draft}
            onWorkplanePoint={onWorkplanePoint}
            onWorkplaneConfirm={onWorkplaneConfirm}
            editWalls={edit3dWalls}
            editDrawings={edit3dDrawings}
            onEditVertex={onEdit3dVertex}
            onEditBody={onEdit3dBody}
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
          mono={mono}
          planViewRef={planViewRef}
          onCursor={onCursor}
          onScale={onScale}
          selectedWallIds={selectedWallIds}
          selectedCeilingIds={selectedCeilingIds}
          selectedOpeningIds={selectedOpeningIds}
          selectedStairIds={selectedStairIds}
          selectedRoomIds={selectedRoomIds}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
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
  mono,
  planViewRef,
  onCursor,
  onScale,
  selectedWallIds,
  selectedCeilingIds,
  selectedOpeningIds,
  selectedStairIds,
  selectedRoomIds,
  roomStamp,
  onStampMove,
  onStampEdit,
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
  mono: boolean;
  planViewRef: React.RefObject<PlanViewHandle>;
  onCursor: (model: Vec2 | null) => void;
  onScale: (n: number) => void;
  selectedWallIds: string[];
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedRoomIds: string[];
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
  onStampEdit: (roomId: string) => void;
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
        selectedRoomIds={selectedRoomIds}
        roomStamp={roomStamp}
        onStampMove={onStampMove}
        onStampEdit={onStampEdit}
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
  mono,
  planViewRef,
  onCursor,
  onScale,
  selectedWallIds,
  selectedCeilingIds,
  selectedOpeningIds,
  selectedStairIds,
  selectedRoomIds,
  roomStamp,
  onStampMove,
  onStampEdit,
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
  mono: boolean;
  planViewRef: React.RefObject<PlanViewHandle>;
  onCursor: (model: Vec2 | null) => void;
  onScale: (n: number) => void;
  selectedWallIds: string[];
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedRoomIds: string[];
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
  onStampEdit: (roomId: string) => void;
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
        selectedRoomIds={selectedRoomIds}
        roomStamp={roomStamp}
        onStampMove={onStampMove}
        onStampEdit={onStampEdit}
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
        selectedDrawingId={selectedDrawingId}
        selectedDrawingIds={selectedDrawingIds}
        gripHandlers={gripHandlers}
      />
      <div className="plan-legend">{t("section.legend", { kind: kindLabel })}</div>
    </section>
  );
}
