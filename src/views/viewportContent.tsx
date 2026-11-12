// Haupt-Viewport-Inhalt (Mitte) — abhängig von aktiver Zeichnungsebene und
// Ansichtstyp. `Content` ist der View-Router: Geschoss→Grundriss/3D,
// Schnitt/Ansicht→SectionPlanView, freie Zeichnung→LevelPlanView. Die beiden
// Plan-Ableitungen (Grundriss bzw. Schnitt/Ansicht) zeichnen dieselbe PlanView.
//
// Extrahiert aus App.tsx (top-level, alles über Props — keine App-Closure).
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";

import { t } from "../i18n";
import { LayoutSheetPane, type LayoutSheetHandlers, type SheetPlanProps } from "../ui/LayoutSheet";
import { SHEET_SCALE_DENOMINATOR } from "../model/layoutModel";
import { flattenCategories } from "../model/types";
import type {
  Ceiling,
  Drawing2D,
  DrawingLevel,
  EdgeGrip,
  Layout,
  Project,
  Roof,
  Vec2,
  Wall,
} from "../model/types";
import { categoryNameForPick } from "../core";
import type { PickKind } from "../core";
import { generatePlan, generateSectionPlan, generateVisibleLevelsPlan } from "../core";
import { planWithExtra } from "../core";
import type { CategoryDisplayResolver, Plan, Primitive } from "../core";
import type { RichTextDoc } from "../text/richText";
import { computeSection, sameSectionInputs, sameSectionLine } from "../core";
import type { SectionOutput } from "../core";
import { generateElevationPlan } from "../core";
import { crossKindOverlayAllowed, tracePlan, withTrace } from "../core";
import { levelMarkerPrimitives, levelMarksEnabled } from "../core";
import { unitsForLevel } from "../tools/displayUnits";
import { setSheetOwnerOutlines, setSheetSnapSegments, snapSegmentsFromPrimitives } from "../tools/sheetSnapGeometry";
import { pushNativeScene, pushNativeWalls } from "./plan/nativeSync";
import { explodeFloorOffsets, selectionHighlightLines } from "../core";
import { clashHighlightLines } from "../analysis/clash";
import { useClashSession } from "../panels/clashSession";
import { greyedFloorIds, hiddenFloorIds } from "../panels/displayMode";
import { applyGroupDimmingToPlan } from "../state/groupActions";
import { useStore } from "../state/appStore";
import { planFitKey } from "../state/viewTabs";
import { classDisplay3d } from "../state/view3dFilter";
import { PlanView } from "./plan/PlanView";
import type {
  GripHandlers,
  GroupableHit,
  HudFieldsState,
  MarqueeSelection,
  PlanSelection,
  PlanViewHandle,
} from "./plan/PlanView";
import { Viewport3D } from "../viewport/Viewport3D";
import type { DisplayResolver } from "../viewport/Viewport3D";
import type { Pick3dHit } from "../viewport/Wasm3DViewport";
import { DrawingTabs } from "../DrawingTabs";
import type { ViewSnapshotTabsHandlers } from "../DrawingTabs";
import type { ToolDraft, ToolHandlers, ToolId } from "../tools/types";
import type { Selection } from "../state/selection";
import { setPickHint } from "../state/pickHintStore";
import type { DetailLevel, RenderMode, View3d, ViewType } from "../model/viewTypes";

/**
 * Akzentfarbe der 3D-Auswahl-Hervorhebung (Umriss-Linien, WASM-Viewport, s.
 * `Content`/`selectionHighlightLines`). Kräftiges Orange — hebt sich vom
 * grauen Wand-/Deckenton, dem hellen Hidden-Line-Weiss und dem Bodenraster ab.
 */
const HIGHLIGHT_RGB: [number, number, number] = [1.0, 0.5, 0.1];
/** Rot der Kollisions-Hüllquader im 3D ([T8]). */
const CLASH_RGB: [number, number, number] = [0.88, 0.14, 0.16];

/**
 * Hauptinhalt — abhängig von der aktiven Zeichnungsebene und dem Ansichtstyp. `memo` ([121]): App
 * reicht stabile Handler, ein App-Render ohne geänderte Eingaben zeichnet Plan/3D nicht neu.
 */
export const Content = memo(function Content({
  project,
  level,
  viewType,
  visibleCodes,
  detail,
  referenceLines,
  scaleDenominator,
  hairline,
  showGrid,
  marqueeColor,
  snapColor,
  hoverDivideDelayMs,
  hoverDivideCount,
  renderMode,
  view3d,
  grid3dVisible,
  onToggleGrid3d,
  section3d,
  onClearSection3d,
  mono,
  viewSnapshotTabs,
  onSelectLevel,
  floorDisplay,
  categoryDisplay,
  planViewRef,
  onCursor,
  onScale,
  selection,
  roomStamp,
  onStampMove,
  onStampEdit,
  onEditDrawingText,
  onEnterGroup,
  groupPath,
  onLeaveGroup,
  editTextId,
  editTextMinHeightM,
  onCommitTextEdit,
  onCloseTextEdit,
  onPlanSelect,
  onPlanMarquee,
  onSegmentCut,
  onPlanContextMenu,
  onViewport3dPick,
  commandActive,
  draft,
  onWorkplanePoint,
  onWorkplaneConfirm,
  activeTool,
  toolInputActive,
  toolHandlers,
  hudFields,
  grips,
  gripHandleLines,
  edgeGrips,
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
  onEdit3dGroup,
  onGrip3dEditTab,
  onGrip3dEditCancel,
  sheet,
}: {
  /**
   * Offenes Layout-Blatt: `level` ist dann dessen Blatt-Ebene (`layoutId`). Gezeichnet wird in
   * derselben Plan-Ansicht wie auf jeder Zeichnungsebene; das Blatt liefert nur den Hintergrund
   * (Papier, Master, Viewports) und das Platzieren der Viewports (ui/LayoutSheet.tsx).
   */
  sheet?: { layout: Layout; handlers: LayoutSheetHandlers } | null;
  project: Project;
  level: DrawingLevel;
  viewType: ViewType;
  visibleCodes: Set<string>;
  detail: DetailLevel;
  referenceLines: boolean;
  /** Papier-Massstab (1:N) — nur für Bemassungs-Feinheiten in Papier-mm. */
  scaleDenominator: number;
  hairline: boolean;
  /** Sichtbares Hintergrund-Raster im Grundriss (rein visuell, s. `SnapSettings.showGrid`). */
  showGrid?: boolean;
  /** Farbe des Auswahlrahmens (Marquee) im Grundriss. */
  marqueeColor: string;
  /** Farbe der Snap-/Endpunkt-Hervorhebung im Grundriss. */
  snapColor: string;
  hoverDivideDelayMs?: number;
  hoverDivideCount?: number;
  renderMode: RenderMode;
  /** Kanonischer 3D-Blickwinkel (Preset) der Perspektive. */
  view3d: View3d;
  /** Sichtwinkel der 3D-Perspektivkamera in Grad. */
  fov: number;
  /** Boden-Referenzraster im 3D-Viewport sichtbar (wirkt nur im WASM-Pfad). */
  grid3dVisible: boolean;
  /** Klick auf den Grid-Umschalter-Button im 3D-Viewport (WASM-Pfad). */
  onToggleGrid3d: () => void;
  /** Aktive 3D-Schnittebene (world point+normal) der gebundenen Schnittlinie,
   *  oder null. Speist Viewport3D/Wasm3DViewport (Live-Schnitt). */
  section3d: { point: [number, number, number]; normal: [number, number, number] } | null;
  /** Schnitt-Bindung im 3D-Viewport lösen (Klick auf den gebundenen Knopf). */
  onClearSection3d: () => void;
  /** Grundriss in Schwarz-Weiss (mono) statt mit Kategorie-/Element-Farben. */
  mono: boolean;
  /** Ausschnitt-Tab-Leiste der Kopfzeile — ein Tab je gespeichertem Ausschnitt
   *  (ViewSnapshot), siehe DrawingTabs.tsx. */
  viewSnapshotTabs: ViewSnapshotTabsHandlers;
  /** Aktiviert eine Zeichnungsebene (Geschoss) — geteilt mit dem Panel
   *  „Zeichnungsebenen". */
  onSelectLevel: (id: string) => void;
  floorDisplay: CategoryDisplayResolver & DisplayResolver;
  categoryDisplay: CategoryDisplayResolver & DisplayResolver;
  displayKey: string;
  planViewRef: React.RefObject<PlanViewHandle>;
  onCursor: (model: Vec2 | null) => void;
  onScale: (n: number) => void;
  /** Die Auswahl ([130]). */
  selection: Selection;
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2, from?: Vec2) => void;
  onStampEdit: (roomId: string) => void;
  onEditDrawingText?: (drawingId: string) => void;
  onEnterGroup?: (hit: GroupableHit) => boolean;
  groupPath: string[];
  onLeaveGroup?: () => void;
  editTextId?: string | null;
  editTextMinHeightM?: number | null;
  onCommitTextEdit?: (doc: RichTextDoc) => void;
  onCloseTextEdit?: () => void;
  onPlanSelect: (sel: PlanSelection) => void;
  onPlanMarquee: (sel: MarqueeSelection) => void;
  onSegmentCut: (drawingId: string, model: Vec2) => void;
  onPlanContextMenu: (info: {
    clientX: number;
    clientY: number;
    model: Vec2;
  }) => void;
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
  hudFields: HudFieldsState | null;
  grips: Vec2[];
  gripHandleLines: { a: Vec2; b: Vec2 }[];
  edgeGrips: EdgeGrip[];
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
  /** Maus-Schritt eines 3D-Griff-Zugs als Gruppe mit Schlüssel (ein Undo-Schritt je Zug). */
  onEdit3dGroup?: (fn: () => void, key: string) => void;
  /** Tab während eines laufenden 3D-Griff-Drags (Endpunkt/Verschieben): Feld-
   * Controller fürs Cursor-HUD öffnen/zykeln, s. App.tsx `cycleGrip3dEditField`. */
  onGrip3dEditTab?: () => void;
  /** Escape während eines laufenden 3D-Griff-Drags: abbrechen (Undo), s.
   * App.tsx `cancelGrip3dEdit`. */
  onGrip3dEditCancel?: () => void;
}) {
  // Auswahl-Hervorhebung im WASM-3D-Viewport: Umriss der gewählten Wand(e)/
  // Decke(n) in Akzent-Orange, immer obenauf (s. selectionHighlightLines in
  // plan/toWalls3d.ts + set_highlight_lines in useWasm3dRenderer). Wirkt NUR
  // im WASM-Zweig (Viewport3D reicht sie nur dort an Wasm3DViewport durch);
  // die three.js-Sicht hebt die Auswahl weiterhin über ihr eigenes Material
  // hervor. Leere Auswahl → null (kein Highlight).
  const clashes = useClashSession().clashes;
  // Explosionsaxonometrie ([65]): Hervorhebung folgt dem auseinandergezogenen 3D-Modell.
  const explode = useStore((s) => (s.explode3d ? s.explode3dGap : 0));
  // Arbeitsebene/Raster/Zeichnen-Vorschau auf dem gehobenen aktiven Geschoss.
  const explodeLift = useMemo(
    () => (explode > 0 ? (explodeFloorOffsets(project, explode)[level.id] ?? 0) : 0),
    [project, explode, level.id],
  );
  const { walls, ceilings, openings, stairs, roofs, contextObjects, columns, solids, trees } = selection;
  const selectionLines = useMemo(
    () =>
      walls.length === 0 &&
      ceilings.length === 0 &&
      openings.length === 0 &&
      stairs.length === 0 &&
      roofs.length === 0 &&
      contextObjects.length === 0 &&
      columns.length === 0 &&
      solids.length === 0 &&
      trees.length === 0
        ? null
        : selectionHighlightLines(project, walls, ceilings, HIGHLIGHT_RGB, openings, stairs, roofs, contextObjects, explode, columns, solids, trees),
    [project, explode, walls, ceilings, openings, stairs, roofs, contextObjects, columns, solids, trees],
  );
  // Kollisionen der letzten Prüfung: rote Hüllquader zusätzlich zur Auswahl-Hervorhebung.
  const highlightLines = useMemo(() => {
    if (clashes.length === 0) return selectionLines;
    const clashLines = clashHighlightLines(clashes, CLASH_RGB);
    if (!selectionLines) return clashLines;
    const merged = new Float32Array(selectionLines.length + clashLines.length);
    merged.set(selectionLines, 0);
    merged.set(clashLines, selectionLines.length);
    return merged;
  }, [selectionLines, clashes]);

  // [180] Klassen, die der Darstellungsmodus des Ebenen-Panels nicht zeichnet, fehlen auch im 3D (die im
  // Ebenen-Baum ausgeschalteten blendet der Kern selbst aus).
  // Graue Klassen erscheinen gedämpft (Geisterschicht), gesperrte sind nicht anwählbar — wie im Grundriss.
  const display3d = useMemo(
    () => classDisplay3d(flattenCategories(project.layers ?? []).map((c) => c.code), categoryDisplay),
    [project.layers, categoryDisplay],
  );
  // [196] Geschosse mit ausgeschaltetem Auge (Zeichnungsebenen-Panel) fehlen auch im 3D.
  const hiddenFloors3d = useMemo(() => hiddenFloorIds(project.drawingLevels, floorDisplay), [project.drawingLevels, floorDisplay]);
  // [180] Geschosse im Darstellungsmodus „grau" stehen im 3D als Geisterschicht.
  const greyFloors3d = useMemo(() => greyedFloorIds(project.drawingLevels, floorDisplay), [project.drawingLevels, floorDisplay]);
  // 3D-Sicht: aus dem Grundriss UND aus Schnitt/Ansicht ([115]); im Schnitt schneidet der Live-Schnitt
  // an der Schnittlinie (App setzt `section3d` beim Wechsel).
  const view3dPane = (
    <section className="pane">
      <div className="pane-title">
        {t("content.perspektiveTitle", { name: level.name })}
      </div>
      <Viewport3D
        project={project}
        hiddenCodes={display3d.hide}
        greyCodes={display3d.grey}
        lockedCodes={display3d.lock}
        hiddenFloors={hiddenFloors3d}
        greyFloors={greyFloors3d}
        renderMode={renderMode}
        detail={detail}
        view3d={view3d}
        groundElevation={(level.baseElevation ?? 0) + explodeLift}
        gridVisible={grid3dVisible}
        onToggleGrid={onToggleGrid3d}
        section3d={section3d}
        onClearSection3d={onClearSection3d}
        onPick3d={onViewport3dPick}
        highlightLines={highlightLines}
        commandActive={commandActive}
        draft={draft}
        onWorkplanePoint={onWorkplanePoint}
        onWorkplaneConfirm={onWorkplaneConfirm}
        hudFields={hudFields}
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
        onEditGroup={onEdit3dGroup}
        onGrip3dEditTab={onGrip3dEditTab}
        onGrip3dEditCancel={onGrip3dEditCancel}
      />
    </section>
  );

  if ((level.kind === "section" || level.kind === "elevation") && viewType === "perspektive") {
    return (
      <main className="content">
        <DrawingTabs handlers={viewSnapshotTabs} />
        {view3dPane}
      </main>
    );
  }

  if (level.kind === "section" || level.kind === "elevation") {
    return (
      <main className="content">
        <DrawingTabs handlers={viewSnapshotTabs} />
        <SectionPlanView
          project={project}
          level={level}
          visibleCodes={visibleCodes}
          categoryDisplay={categoryDisplay}
          detail={detail}
          referenceLines={referenceLines}
          scaleDenominator={scaleDenominator}
          hairline={hairline}
          showGrid={showGrid}
          marqueeColor={marqueeColor}
          snapColor={snapColor}
          hoverDivideDelayMs={hoverDivideDelayMs}
          hoverDivideCount={hoverDivideCount}
          mono={mono}
          planViewRef={planViewRef}
          onCursor={onCursor}
          onScale={onScale}
          selection={selection}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
          onEditDrawingText={onEditDrawingText}
          onEnterGroup={onEnterGroup}
          groupPath={groupPath}
          onLeaveGroup={onLeaveGroup}
          editTextId={editTextId}
          editTextMinHeightM={editTextMinHeightM}
          onCommitTextEdit={onCommitTextEdit}
          onCloseTextEdit={onCloseTextEdit}
          onOpenSectionLevel={onSelectLevel}
          onPlanSelect={onPlanSelect}
          onPlanMarquee={onPlanMarquee}
          onSegmentCut={onSegmentCut}
          onPlanContextMenu={onPlanContextMenu}
          activeTool={activeTool}
          toolInputActive={toolInputActive}
          toolHandlers={toolHandlers}
          hudFields={hudFields}
          grips={grips}
          gripHandleLines={gripHandleLines}
          edgeGrips={edgeGrips}
          gripHandlers={gripHandlers}
        />
      </main>
    );
  }

  // Freie Zeichnung: dieselbe Plan-Ansicht wie ein Geschoss (generatePlan filtert
  // `drawings2d` nach `level.id`), nur OHNE Geschoss-Eigenschaftsleiste und ohne
  // 3D-Umschaltung — eine Zeichnung hat keine Höhe/3D. So sind importierte
  // DXF-Polylinien hier sofort sichtbar und mit den 2D-Werkzeugen bearbeitbar.
  // Deckenspiegel ([100]): wie eine Zeichnung (2D, Inhalt aus dem Kern), ohne 3D-Umschaltung.
  if (level.kind === "drawing" || level.kind === "ceiling") {
    // Blatt-Ebene eines offenen Layouts: Papier 1:1 (Massstab 1), Hintergrund + Viewports vom Blatt.
    const plan = (sheetPlan?: SheetPlanProps) => (
        <LevelPlanView
          backdrop={sheetPlan?.backdrop}
          fitBounds={sheetPlan?.fitBounds}
          project={project}
          level={level}
          visibleCodes={visibleCodes}
          categoryDisplay={categoryDisplay}
          floorDisplay={floorDisplay}
          detail={detail}
          referenceLines={referenceLines}
          scaleDenominator={sheetPlan ? SHEET_SCALE_DENOMINATOR : scaleDenominator}
          hairline={hairline}
          showGrid={showGrid}
          marqueeColor={marqueeColor}
          snapColor={snapColor}
          hoverDivideDelayMs={hoverDivideDelayMs}
          hoverDivideCount={hoverDivideCount}
          mono={mono}
          planViewRef={planViewRef}
          onCursor={onCursor}
          onScale={onScale}
          selection={selection}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
          onEditDrawingText={onEditDrawingText}
          onEnterGroup={onEnterGroup}
          groupPath={groupPath}
          onLeaveGroup={onLeaveGroup}
          editTextId={editTextId}
          editTextMinHeightM={editTextMinHeightM}
          onCommitTextEdit={onCommitTextEdit}
          onCloseTextEdit={onCloseTextEdit}
          onOpenSectionLevel={onSelectLevel}
          onPlanSelect={sheetPlan?.onPlanSelect ?? onPlanSelect}
          onPlanMarquee={onPlanMarquee}
          onSegmentCut={onSegmentCut}
          onPlanContextMenu={onPlanContextMenu}
          activeTool={activeTool}
          toolInputActive={toolInputActive}
          toolHandlers={toolHandlers}
          hudFields={hudFields}
          grips={grips}
          gripHandleLines={gripHandleLines}
          edgeGrips={edgeGrips}
          gripHandlers={gripHandlers}
        />
    );
    if (level.layoutId && sheet && sheet.layout.id === level.layoutId) {
      return (
        <main className="content">
          <LayoutSheetPane
            project={project}
            layout={sheet.layout}
            handlers={sheet.handlers}
            toolInputActive={toolInputActive}
            onPlanSelect={onPlanSelect}
            planViewRef={planViewRef}
          >
            {plan}
          </LayoutSheetPane>
        </main>
      );
    }
    return (
      <main className="content">
        <DrawingTabs handlers={viewSnapshotTabs} />
        {plan()}
      </main>
    );
  }

  // Geschoss: Dokument-Tabs + gewählte Ansicht. Geschosshöhe/Schnitthöhe
  // werden in den Geschoss-Einstellungen gepflegt (Rechtsklick auf das
  // Geschoss im Panel „Zeichnungsebenen"), nicht mehr hier in der Kopfzeile.
  return (
    <main className="content">
      <DrawingTabs handlers={viewSnapshotTabs} />
      {viewType === "perspektive" ? (
        view3dPane
      ) : (
        <LevelPlanView
          project={project}
          level={level}
          visibleCodes={visibleCodes}
          categoryDisplay={categoryDisplay}
          floorDisplay={floorDisplay}
          detail={detail}
          referenceLines={referenceLines}
          scaleDenominator={scaleDenominator}
          hairline={hairline}
          showGrid={showGrid}
          marqueeColor={marqueeColor}
          snapColor={snapColor}
          hoverDivideDelayMs={hoverDivideDelayMs}
          hoverDivideCount={hoverDivideCount}
          mono={mono}
          planViewRef={planViewRef}
          onCursor={onCursor}
          onScale={onScale}
          selection={selection}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
          onEditDrawingText={onEditDrawingText}
          onEnterGroup={onEnterGroup}
          groupPath={groupPath}
          onLeaveGroup={onLeaveGroup}
          editTextId={editTextId}
          editTextMinHeightM={editTextMinHeightM}
          onCommitTextEdit={onCommitTextEdit}
          onCloseTextEdit={onCloseTextEdit}
          onOpenSectionLevel={onSelectLevel}
          onPlanSelect={onPlanSelect}
          onPlanMarquee={onPlanMarquee}
          onSegmentCut={onSegmentCut}
          onPlanContextMenu={onPlanContextMenu}
          activeTool={activeTool}
          toolInputActive={toolInputActive}
          toolHandlers={toolHandlers}
          hudFields={hudFields}
          grips={grips}
          gripHandleLines={gripHandleLines}
          edgeGrips={edgeGrips}
          gripHandlers={gripHandlers}
        />
      )}
    </main>
  );
});

// Auswahl-Felder (wallId/ceilingId/…) aus einer Referenz-Überlagerung entfernen:
// die Geometrie stammt aus einer FREMDEN Projektion (z. B. Schnitt-Koordinaten
// im X/Y-Raum eines Grundrisses) — ein Klick darauf darf niemals das
// eigentliche (real positionierte) Bauteil selektieren.
const OVERLAY_SELECTABLE_ID_KEYS = [
  "wallId",
  "drawingId",
  "ceilingId",
  "openingId",
  "stairId",
  "roomId",
  "columnId",
  "roofId",
  "extrudedSolidId",
  "contextObjectId",
  "sectionLineId",
] as const;
function stripSelectableIds(pr: Primitive): Primitive {
  const copy: Record<string, unknown> = { ...(pr as unknown as Record<string, unknown>) };
  for (const k of OVERLAY_SELECTABLE_ID_KEYS) delete copy[k];
  return copy as unknown as Primitive;
}

/**
 * Fremd-Art-Überlagerung über Auge/Darstellungsmodus (Ebenen-Komposition): Geschoss und freie Zeichnung teilen
 * den X/Y-Raum und legen sich gegenseitig darunter (Auge an, Modus „Andere grau" dimmt), nicht anwählbar. Alles
 * andere — ein Schnitt, eine Ansicht, ein anderes Geschoss — kommt bewusst gewählt als Pausfolie dazu ([205],
 * {@link useTracePlan}).
 */
function useCrossKindOverlay(
  project: Project,
  activeLevel: DrawingLevel,
  floorDisplay: CategoryDisplayResolver,
  visibleCodes: Set<string>,
  categoryDisplay: CategoryDisplayResolver,
  detail: DetailLevel,
  referenceLines: boolean,
  mono: boolean,
  scaleDenominator: number,
): Primitive[] {
  const overlayLevels = useMemo(
    () =>
      project.drawingLevels.filter(
        (l) =>
          l.kind !== activeLevel.kind &&
          crossKindOverlayAllowed(activeLevel.kind, l.kind) &&
          floorDisplay(l.id).render,
      ),
    [project.drawingLevels, activeLevel.kind, floorDisplay],
  );
  return useMemo(() => {
    const out: Primitive[] = [];
    for (const l of overlayLevels) {
      const greyed = floorDisplay(l.id).greyed;
      // Dieselbe Grundriss-Pipeline, aber ohne die projektglobalen Zutaten (Kontext-Konturen/Schnittlinien) —
      // die liefert bereits die aktive Ebene selbst (kein Doppel-Zeichnen).
      const prims = generatePlan(project, l.id, visibleCodes, categoryDisplay, detail, referenceLines, mono, false, scaleDenominator).primitives;
      for (const pr of prims) out.push(stripSelectableIds(greyed ? { ...pr, greyed: true } : pr));
    }
    return out;
  }, [overlayLevels, project, mono, floorDisplay, visibleCodes, categoryDisplay, detail, referenceLines, scaleDenominator]);
}

/**
 * [205] Pausfolie des aktiven Reiters (`state.trace`, s. `state/traceRef.ts`): die gewählte Quelle als Plan aus
 * dem Kern (`tracePlan`), ausgerichtet, verschoben/gedreht, gefärbt, ohne Auswahl-Ids. `null` ohne Pause.
 */
function useTracePlan(
  project: Project,
  level: DrawingLevel,
  activeBounds: Plan["bounds"] | undefined,
  visibleCodes: Set<string>,
  categoryDisplay: CategoryDisplayResolver,
  detail: DetailLevel,
  referenceLines: boolean,
  mono: boolean,
  scaleDenominator: number,
): Plan | null {
  const trace = useStore((s) => s.trace);
  const bKey = activeBounds ? `${activeBounds.minX},${activeBounds.minY},${activeBounds.maxX},${activeBounds.maxY}` : "";
  return useMemo(
    () => {
      if (!trace?.show) return null;
      try {
        return tracePlan(project, level, trace, { visibleCodes, categoryDisplay, detail, referenceLines, mono, scaleDenominator, activeBounds });
      } catch (e) {
        console.warn("Pausfolie fehlgeschlagen:", e);
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trace, project, level, bKey, visibleCodes, categoryDisplay, detail, referenceLines, mono, scaleDenominator],
  );
}

/** Abgeleiteter Grundriss eines Geschosses. */
function LevelPlanView({
  backdrop,
  fitBounds,
  project,
  level,
  visibleCodes,
  categoryDisplay,
  floorDisplay,
  detail,
  referenceLines,
  scaleDenominator,
  hairline,
  showGrid,
  marqueeColor,
  snapColor,
  hoverDivideDelayMs,
  hoverDivideCount,
  mono,
  planViewRef,
  onCursor,
  onScale,
  selection,
  roomStamp,
  onStampMove,
  onStampEdit,
  onEditDrawingText,
  onEnterGroup,
  groupPath,
  onLeaveGroup,
  editTextId,
  editTextMinHeightM,
  onCommitTextEdit,
  onCloseTextEdit,
  onOpenSectionLevel,
  onPlanSelect,
  onPlanMarquee,
  onSegmentCut,
  onPlanContextMenu,
  activeTool,
  toolInputActive,
  toolHandlers,
  hudFields,
  grips,
  gripHandleLines,
  edgeGrips,
  gripHandlers,
}: {
  /** Hintergrund unter der Zeichnung (Layout-Blatt), s. `PlanView.backdrop`. */
  backdrop?: SheetPlanProps["backdrop"];
  /** Einpass-Bereich statt der Plan-Grenzen (Layout-Blatt). */
  fitBounds?: SheetPlanProps["fitBounds"];
  project: Project;
  level: DrawingLevel;
  visibleCodes: Set<string>;
  categoryDisplay: CategoryDisplayResolver;
  floorDisplay: CategoryDisplayResolver;
  detail: DetailLevel;
  referenceLines: boolean;
  /** Papier-Massstab (1:N) — nur für Bemassungs-Feinheiten in Papier-mm. */
  scaleDenominator: number;
  hairline: boolean;
  showGrid?: boolean;
  marqueeColor: string;
  snapColor: string;
  hoverDivideDelayMs?: number;
  hoverDivideCount?: number;
  mono: boolean;
  planViewRef: React.RefObject<PlanViewHandle>;
  onCursor: (model: Vec2 | null) => void;
  onScale: (n: number) => void;
  /** Die Auswahl ([130]). */
  selection: Selection;
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2, from?: Vec2) => void;
  onStampEdit: (roomId: string) => void;
  onEditDrawingText?: (drawingId: string) => void;
  onEnterGroup?: (hit: GroupableHit) => boolean;
  groupPath: string[];
  onLeaveGroup?: () => void;
  editTextId?: string | null;
  editTextMinHeightM?: number | null;
  onCommitTextEdit?: (doc: RichTextDoc) => void;
  onCloseTextEdit?: () => void;
  onOpenSectionLevel?: (id: string) => void;
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
  hudFields: HudFieldsState | null;
  grips: Vec2[];
  gripHandleLines: { a: Vec2; b: Vec2 }[];
  edgeGrips: EdgeGrip[];
  gripHandlers: GripHandlers;
}) {
  const projectEpoch = useStore((s) => s.projectEpoch);
  // Fremd-Art-Referenz-Unterlage (Nutzer-Wunsch: "will mal etwas vom Schnitt
  // abzeichnen" — UND umgekehrt "in der Ansicht auch mal einen Grundriss
  // zeigen"): jede andere sichtbare Zeichnungsebene ANDERER Art (Auge an,
  // Modus "andere grau" dimmt sie) erscheint als Kalkierpapier-Unterlage,
  // s. useCrossKindOverlay.
  const overlayPrimitives = useCrossKindOverlay(
    project,
    level,
    floorDisplay,
    visibleCodes,
    categoryDisplay,
    detail,
    referenceLines,
    mono,
    scaleDenominator,
  );

  // Detailgrad + Referenzlinien fließen in die Plan-Erzeugung ein (Symbole,
  // Schraffuren/Linienfeinheit bzw. Wand-Achslinien).
  const basePlan = useMemo(() => {
    // Überlagert ALLE sichtbaren Geschoss-/Zeichnungs-Ebenen derselben Art wie
    // `level` in einem Plan (aktive Ebene farbig, andere je Darstellungsmodus
    // gedimmt/gesperrt — Nutzer-Wunsch "mehrere Geschosse gleichzeitig
    // einschaltbar", s. plan/generatePlan.ts::generateVisibleLevelsPlan). [203] Andere
    // Geschosse nur als gedimmte Pausfolie (Modus „Andere grau"), sonst nur das eigene.
    const p = generateVisibleLevelsPlan(
      project,
      level.id,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      mono,
      floorDisplay,
      scaleDenominator,
      // Kompakte Linien-Unterlage (s. Plan.underlay): hält Kataster-Importe
      // handhabbar; PlanView materialisiert sie, wo echte Primitive nötig sind.
      true,
    );
    // Überlagerung anhängen, ohne die Primitive des Plans zu lesen (lazy, [K3d]).
    const withOverlay = overlayPrimitives.length === 0 ? p : planWithExtra(p, [], overlayPrimitives);
    // Gruppen-Isolation ("Gruppe betreten"): alles ausserhalb der aktiven
    // Gruppe gedimmt, s. state/groupActions.ts::applyGroupDimmingToPlan (die
    // kompakte Linien-Unterlage bleibt dabei kompakt).
    return applyGroupDimmingToPlan(withOverlay, project, groupPath);
  }, [
    project,
    level.id,
    visibleCodes,
    categoryDisplay,
    detail,
    referenceLines,
    mono,
    floorDisplay,
    overlayPrimitives,
    groupPath,
  ]);
  // [205] Pausfolie des Reiters unter (bzw. über) dem Grundriss — nicht anwählbar (ohne Ids), nicht gedimmt.
  const trace = useTracePlan(project, level, basePlan.bounds, visibleCodes, categoryDisplay, detail, referenceLines, mono, scaleDenominator);
  const traceAbove = useStore((s) => !!s.trace?.above);
  const plan = useMemo(() => withTrace(basePlan, trace, traceAbove), [basePlan, trace, traceAbove]);

  // Kategorie-/Layer-Name für die Objekt-Liste (Cmd/Strg+Klick), s. plan/pickLabels.ts.
  const describePick = useCallback(
    (kind: PickKind, id: string) => categoryNameForPick(project, kind, id),
    [project],
  );


  // Live-Spiegelung in die nativen wgpu-Fenster (No-op ohne Tauri, debounced):
  // EXAKT der sichtbare Plan (gleiches Geschoss, gleicher Detailgrad) fürs
  // 2D-Fenster, die Projekt-Wände fürs 3D-Fenster.
  useEffect(() => {
    pushNativeScene(plan);
  }, [plan]);
  // Explosionsaxonometrie ([65]) auch im nativen 3D-Fenster.
  const explode = useStore((s) => (s.explode3d ? s.explode3dGap : 0));
  // [180] Mit dem Darstellungsmodus der Klassen wie im WASM-Viewport (aus, grau = Geisterschicht).
  const nativeHide = useMemo(() => {
    const d = classDisplay3d(flattenCategories(project.layers ?? []).map((c) => c.code), categoryDisplay);
    return { hide: d.hide, grey: d.grey, hideFloors: hiddenFloorIds(project.drawingLevels, floorDisplay), greyFloors: greyedFloorIds(project.drawingLevels, floorDisplay) };
  }, [project.layers, project.drawingLevels, categoryDisplay, floorDisplay]);
  useEffect(() => {
    pushNativeWalls(project, explode, nativeHide);
  }, [project, explode, nativeHide]);

  return (
    <section className="pane">
      {groupPath.length > 0 && (
        <button
          type="button"
          className="pane-leave-group-btn"
          onClick={onLeaveGroup}
          title={t("group.leave.hint")}
        >
          {t("group.leave")}
        </button>
      )}
      <PlanView
        ref={planViewRef}
        plan={plan}
        describePick={describePick}
        onPickHint={setPickHint}
        resetKey={`${level.id}#${projectEpoch}`}
        fitKey={planFitKey(level, projectEpoch)}
        onCursor={onCursor}
        onScale={onScale}
        selection={selection}
        roomStamp={roomStamp}
        onStampMove={onStampMove}
        onStampEdit={onStampEdit}
        onEditDrawingText={onEditDrawingText}
        onEnterGroup={onEnterGroup}
        editTextId={editTextId}
        editTextMinHeightM={editTextMinHeightM}
        onCommitTextEdit={onCommitTextEdit}
        onCloseTextEdit={onCloseTextEdit}
        onOpenSectionLevel={onOpenSectionLevel}
        onSelect={onPlanSelect}
        onMarquee={onPlanMarquee}
        onSegmentCut={onSegmentCut}
        onContextMenu={onPlanContextMenu}
        activeTool={activeTool}
        toolInputActive={toolInputActive}
        toolHandlers={toolHandlers}
          hudFields={hudFields}
        grips={grips}
        gripHandleLines={gripHandleLines}
        edgeGrips={edgeGrips}
        hairline={hairline}
        showGrid={showGrid}
        marqueeColor={marqueeColor}
        snapColor={snapColor}
        hoverDivideDelayMs={hoverDivideDelayMs}
        hoverDivideCount={hoverDivideCount}
        gripHandlers={gripHandlers}
        backdrop={backdrop}
        units={unitsForLevel(level)}
        fitBounds={fitBounds}
      />
      {/* NACH PlanView gerendert (nicht als box-shadow auf .pane), damit der
          Isolations-Rahmen über der PlanView-SVG sichtbar bleibt. */}
      {groupPath.length > 0 && <div className="pane-isolation-frame" />}
    </section>
  );
}

/**
 * Schnitt-/Ansichts-Ebene: der Kern rechnet Schnitt bzw. Ansicht entlang der Schnittlinie der
 * Ebene (`generateSectionPlan`/`generateElevationPlan`, Plan-Puffer v2 mit Pick-Ids, samt den
 * geschnittenen Fenstern/Türen), die dieselbe PlanView wie ein Grundriss zeichnet.
 *
 * Der Schnitt ist asynchron (die freien Körper baut truck); bis das Ergebnis da ist bzw. wenn
 * die Ebene keine Schnittlinie trägt, wird ein Hinweis eingeblendet.
 */
function SectionPlanView({
  project,
  level,
  visibleCodes,
  categoryDisplay,
  detail,
  referenceLines,
  scaleDenominator,
  hairline,
  showGrid,
  marqueeColor,
  snapColor,
  hoverDivideDelayMs,
  hoverDivideCount,
  mono,
  planViewRef,
  onCursor,
  onScale,
  selection,
  roomStamp,
  onStampMove,
  onStampEdit,
  onEditDrawingText,
  onEnterGroup,
  groupPath,
  onLeaveGroup,
  editTextId,
  editTextMinHeightM,
  onCommitTextEdit,
  onCloseTextEdit,
  onOpenSectionLevel,
  onPlanSelect,
  onPlanMarquee,
  onSegmentCut,
  onPlanContextMenu,
  activeTool,
  toolInputActive,
  toolHandlers,
  hudFields,
  grips,
  gripHandleLines,
  edgeGrips,
  gripHandlers,
}: {
  project: Project;
  level: DrawingLevel;
  visibleCodes: Set<string>;
  categoryDisplay: CategoryDisplayResolver;
  detail: DetailLevel;
  referenceLines: boolean;
  /** Papier-Massstab (1:N) — nur für Bemassungs-Feinheiten in Papier-mm. */
  scaleDenominator: number;
  hairline: boolean;
  showGrid?: boolean;
  marqueeColor: string;
  snapColor: string;
  hoverDivideDelayMs?: number;
  hoverDivideCount?: number;
  mono: boolean;
  planViewRef: React.RefObject<PlanViewHandle>;
  onCursor: (model: Vec2 | null) => void;
  onScale: (n: number) => void;
  /** Die Auswahl ([130]). */
  selection: Selection;
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2, from?: Vec2) => void;
  onStampEdit: (roomId: string) => void;
  onEditDrawingText?: (drawingId: string) => void;
  onEnterGroup?: (hit: GroupableHit) => boolean;
  groupPath: string[];
  onLeaveGroup?: () => void;
  editTextId?: string | null;
  editTextMinHeightM?: number | null;
  onCommitTextEdit?: (doc: RichTextDoc) => void;
  onCloseTextEdit?: () => void;
  onOpenSectionLevel?: (id: string) => void;
  onPlanSelect: (sel: PlanSelection) => void;
  onPlanMarquee: (sel: MarqueeSelection) => void;
  onSegmentCut: (drawingId: string, model: Vec2) => void;
  onPlanContextMenu: (info: { clientX: number; clientY: number; model: Vec2 }) => void;
  activeTool: ToolId;
  toolInputActive: boolean;
  toolHandlers: ToolHandlers;
  hudFields: HudFieldsState | null;
  grips: Vec2[];
  gripHandleLines: { a: Vec2; b: Vec2 }[];
  edgeGrips: EdgeGrip[];
  gripHandlers: GripHandlers;
}) {
  const projectEpoch = useStore((s) => s.projectEpoch);
  // Kontext-Objekte hebt der Schnitt (wie bisher) nicht hervor.
  const sectionSelection = useMemo(
    () => (selection.contextObjects.length ? { ...selection, contextObjects: [] } : selection),
    [selection],
  );
  // Die Ansicht (kind "elevation") ist synchron (Kern, Painter); nur der Schnitt wartet auf die
  // truck-Körper.
  const isElevation = level.kind === "elevation";
  const [output, setOutput] = useState<SectionOutput | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">(
    "loading",
  );

  // Stabile Eingaben der Projektion: nur ein neues Objekt, wenn sich etwas
  // Schnitt-Relevantes geändert hat (nicht bei jeder 2D-Linie im Schnitt, s.
  // sameSectionInputs). Spart das Neurechnen UND verhindert, dass die Ansicht
  // bei jeder Änderung kurz leer wird.
  const inputsRef = useRef<{ project: Project; level: DrawingLevel } | null>(null);
  const prevInputs = inputsRef.current;
  const inputs =
    prevInputs &&
    sameSectionInputs(prevInputs.project, project) &&
    sameSectionLine(prevInputs.level, level)
      ? prevInputs
      : { project, level };
  useEffect(() => {
    inputsRef.current = inputs;
  });

  // Ebenenwechsel: alten Schnitt verwerfen (gehört zu einer anderen Linie).
  useEffect(() => {
    setOutput(null);
    setStatus("loading");
  }, [level.id]);

  useEffect(() => {
    if (isElevation) return; // Ansicht: kein WASM-Schnitt (synchroner Generator).
    let disposed = false;
    // Bisheriges Ergebnis stehen lassen, bis das neue fertig ist — sonst
    // flackert die Ansicht auf "wird berechnet …" und die PlanView (Zoom/
    // Ausschnitt) wird bei jeder Änderung neu aufgebaut.
    void (async () => {
      try {
        const out = await computeSection(inputs.project, inputs.level);
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
  }, [inputs, isElevation]);

  // Ansichts-Plan: gefüllte Fassadenansicht inkl. optionalem Schatten
  // (level.shadows). Liefert null, wenn die Ebene keine Ansichtslinie trägt.
  const elevationPlan = useMemo(
    () =>
      isElevation
        ? generateElevationPlan(inputs.project, inputs.level, { mono, visibleCodes, categoryDisplay, scaleDenominator })
        : null,
    [isElevation, inputs, mono, visibleCodes, categoryDisplay, scaleDenominator],
  );

  const sectionPlan = useMemo(
    () =>
      !isElevation && output
        ? generateSectionPlan(output, mono, {
            hiddenLines: level.hiddenLines,
            visibleCodes,
            categoryDisplay,
            openings: true,
            scaleDenominator,
            detail,
          })
        : null,
    [isElevation, output, mono, level.hiddenLines, visibleCodes, categoryDisplay, inputs, scaleDenominator, detail],
  );
  const rawPlan = isElevation ? elevationPlan : sectionPlan;
  // [205] Pausfolie des Reiters (früher nur die Grundriss-Unterlage `planUnderlayId`): jede andere Ebene, ein
  // Grundriss ausgerichtet unter dem Schnitt (Kern `plan/trace.rs` → `underlay.rs`), ein anderer Schnitt / eine
  // Ansicht höhengleich.
  const trace = useTracePlan(project, level, rawPlan?.bounds, visibleCodes, categoryDisplay, detail, referenceLines, mono, scaleDenominator);
  const traceAbove = useStore((s) => !!s.trace?.above);
  // Fangkanten auch auf der Pause (Abzeichnen).
  const overlayPrimitives = useMemo(() => (trace ? trace.primitives : []), [trace]);
  // Eigene 2D-Elemente des Schnitts/der Ansicht (Bemassung, Höhenkoten,
  // Beschriftung, Ergänzungslinien …): liegen in `drawings2d` mit
  // `levelId === level.id` im Blatt-Raum (u, Höhe). Bisher zeichnete die Ansicht
  // NUR die abgeleitete Projektion — was man im Schnitt zeichnete, wurde zwar
  // gespeichert, blieb aber unsichtbar.
  const sheetDrawings = useMemo(
    () =>
      generatePlan(
        project,
        level.id,
        visibleCodes,
        categoryDisplay,
        detail,
        referenceLines,
        mono,
        false,
        scaleDenominator,
      ),
    [project, level.id, visibleCodes, categoryDisplay, detail, referenceLines, mono, scaleDenominator],
  );
  // Automatische Höhenkoten links neben der Zeichnung (abschaltbar je Ebene).
  const marks = useMemo(
    () =>
      rawPlan && levelMarksEnabled(level, project, (c) => visibleCodes.has(c) && categoryDisplay(c).render)
        ? levelMarkerPrimitives(project, rawPlan.bounds, rawPlan.primitives)
        : [],
    [rawPlan, level, project, visibleCodes, categoryDisplay],
  );
  const withOverlay = useMemo(() => {
    if (!rawPlan) return rawPlan;
    const extra = [...marks, ...sheetDrawings.primitives];
    if (overlayPrimitives.length === 0 && extra.length === 0) return rawPlan;
    const b = { ...rawPlan.bounds };
    const grow = (x: number, y: number) => {
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    };
    if (trace) {
      grow(trace.bounds.minX, trace.bounds.minY);
      grow(trace.bounds.maxX, trace.bounds.maxY);
    }
    if (sheetDrawings.primitives.length > 0) {
      const eb = sheetDrawings.bounds;
      grow(eb.minX, eb.minY);
      grow(eb.maxX, eb.maxY);
    }
    for (const pr of marks) if (pr.kind === "line") grow(pr.a.x, pr.a.y);
    // Pause zuunterst (bzw. ganz oben), Blatt-Zeichnungen über dem Schnitt.
    const own = [...rawPlan.primitives, ...extra];
    return { ...rawPlan, primitives: traceAbove ? [...own, ...overlayPrimitives] : [...overlayPrimitives, ...own], bounds: b };
  }, [rawPlan, overlayPrimitives, trace, traceAbove, sheetDrawings, marks]);
  // Fangkanten der abgeleiteten Geometrie (Schnitt-/Ansichtskanten + Unterlage)
  // für `computeSnap` bereitstellen — die stehen nicht im Projekt. Die eigenen
  // 2D-Elemente fängt computeSnap ohnehin über `drawings2d`.
  useEffect(() => {
    if (!rawPlan) return;
    setSheetSnapSegments(
      level.id,
      snapSegmentsFromPrimitives([...overlayPrimitives, ...rawPlan.primitives]),
    );
    setSheetOwnerOutlines(level.id, rawPlan.primitives);
    return () => {
      setSheetSnapSegments(level.id, null);
      setSheetOwnerOutlines(level.id, null);
    };
  }, [rawPlan, overlayPrimitives, level.id]);
  // Gruppen-Isolation ("Gruppe betreten") gilt auch für Schnitt-/Ansichts-
  // Pläne, s. state/groupActions.ts::applyGroupDimming.
  const plan = useMemo(
    () =>
      withOverlay && groupPath.length > 0
        ? applyGroupDimmingToPlan(withOverlay, project, groupPath)
        : withOverlay,
    [withOverlay, project, groupPath],
  );
  const effStatus = isElevation ? (elevationPlan ? "ready" : "empty") : status;

  const kindLabel = level.kind === "section" ? t("stub.section") : t("stub.elevation");

  if (!plan || effStatus !== "ready") {
    const note =
      effStatus === "empty"
        ? t("section.empty", { kind: kindLabel })
        : effStatus === "error"
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
      <div className="pane-title pane-title--ruled">
        {t("content.sectionTitle", { name: level.name, kind: kindLabel })}
      </div>
      {groupPath.length > 0 && (
        <button
          type="button"
          className="pane-leave-group-btn"
          onClick={onLeaveGroup}
          title={t("group.leave.hint")}
        >
          {t("group.leave")}
        </button>
      )}
      <PlanView
        ref={planViewRef}
        plan={plan}
        resetKey={`${level.id}#${projectEpoch}`}
        onCursor={onCursor}
        onScale={onScale}
        selection={sectionSelection}
        roomStamp={roomStamp}
        onStampMove={onStampMove}
        onStampEdit={onStampEdit}
        onEditDrawingText={onEditDrawingText}
        onEnterGroup={onEnterGroup}
        editTextId={editTextId}
        editTextMinHeightM={editTextMinHeightM}
        onCommitTextEdit={onCommitTextEdit}
        onCloseTextEdit={onCloseTextEdit}
        onOpenSectionLevel={onOpenSectionLevel}
        onSelect={onPlanSelect}
        onMarquee={onPlanMarquee}
        onSegmentCut={onSegmentCut}
        onContextMenu={onPlanContextMenu}
        activeTool={activeTool}
        toolInputActive={toolInputActive}
        toolHandlers={toolHandlers}
          hudFields={hudFields}
        grips={grips}
        gripHandleLines={gripHandleLines}
        edgeGrips={edgeGrips}
        hairline={hairline}
        showGrid={showGrid}
        marqueeColor={marqueeColor}
        snapColor={snapColor}
        hoverDivideDelayMs={hoverDivideDelayMs}
        hoverDivideCount={hoverDivideCount}
        gripHandlers={gripHandlers}
        sheetBodies
      />
      {/* NACH PlanView gerendert (nicht als box-shadow auf .pane), damit der
          Isolations-Rahmen über der PlanView-SVG sichtbar bleibt. */}
      {groupPath.length > 0 && <div className="pane-isolation-frame" />}
      <div className="plan-legend">{t("section.legend", { kind: kindLabel })}</div>
    </section>
  );
}
