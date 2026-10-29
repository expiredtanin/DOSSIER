// Haupt-Viewport-Inhalt (Mitte) — abhängig von aktiver Zeichnungsebene und
// Ansichtstyp. `Content` ist der View-Router: Geschoss→Grundriss/3D,
// Schnitt/Ansicht→SectionPlanView, freie Zeichnung→LevelPlanView. Die beiden
// Plan-Ableitungen (Grundriss bzw. Schnitt/Ansicht) zeichnen dieselbe PlanView.
//
// Extrahiert aus App.tsx (top-level, alles über Props — keine App-Closure).
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { t } from "../i18n";
import type {
  Ceiling,
  Drawing2D,
  DrawingLevel,
  EdgeGrip,
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
import { crossKindOverlayAllowed, planUnderlayPrimitives } from "../core";
import { sectionOpeningPrimitives } from "../core";
import { levelMarkerPrimitives, levelMarksEnabled } from "../core";
import { setSheetOwnerOutlines, setSheetSnapSegments, snapSegmentsFromPrimitives } from "../tools/sheetSnapGeometry";
import { pushNativeScene, pushNativeWalls } from "./plan/nativeSync";
import { selectionHighlightLines } from "../core";
import { applyGroupDimmingToPlan } from "../state/groupActions";
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
import type { DetailLevel, RenderMode, View3d, ViewType } from "../model/viewTypes";

/**
 * Akzentfarbe der 3D-Auswahl-Hervorhebung (Umriss-Linien, WASM-Viewport, s.
 * `Content`/`selectionHighlightLines`). Kräftiges Orange — hebt sich vom
 * grauen Wand-/Deckenton, dem hellen Hidden-Line-Weiss und dem Bodenraster ab.
 */
const HIGHLIGHT_RGB: [number, number, number] = [1.0, 0.5, 0.1];

/** Hauptinhalt — abhängig von der aktiven Zeichnungsebene und dem Ansichtstyp. */
export function Content({
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
  selectedWallIds,
  selectedCeilingIds,
  selectedOpeningIds,
  selectedStairIds,
  selectedExtrudedSolidIds,
  selectedColumnIds,
  selectedGroupIds,
  selectedRoomIds,
  selectedRoofIds,
  selectedContextObjectIds,
  selectedSectionLineIds,
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
  onEdit3dGroup,
  onGrip3dEditTab,
  onGrip3dEditCancel,
}: {
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
  selectedWallIds: string[];
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedExtrudedSolidIds: string[];
  selectedColumnIds: string[];
  selectedGroupIds: string[];
  selectedRoomIds: string[];
  selectedRoofIds: string[];
  selectedContextObjectIds: string[];
  selectedSectionLineIds: string[];
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
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
  const highlightLines = useMemo(
    () =>
      selectedWallIds.length === 0 &&
      selectedCeilingIds.length === 0 &&
      selectedOpeningIds.length === 0 &&
      selectedStairIds.length === 0 &&
      selectedRoofIds.length === 0 &&
      selectedContextObjectIds.length === 0
        ? null
        : selectionHighlightLines(
            project,
            selectedWallIds,
            selectedCeilingIds,
            HIGHLIGHT_RGB,
            selectedOpeningIds,
            selectedStairIds,
            selectedRoofIds,
            selectedContextObjectIds,
          ),
    [
      project,
      selectedWallIds,
      selectedCeilingIds,
      selectedOpeningIds,
      selectedStairIds,
      selectedRoofIds,
      selectedContextObjectIds,
    ],
  );

  if (level.kind === "section" || level.kind === "elevation") {
    return (
      <main className="content">
        <DrawingTabs project={project} handlers={viewSnapshotTabs} />
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
          selectedWallIds={selectedWallIds}
          selectedCeilingIds={selectedCeilingIds}
          selectedOpeningIds={selectedOpeningIds}
          selectedStairIds={selectedStairIds}
          selectedExtrudedSolidIds={selectedExtrudedSolidIds}
          selectedColumnIds={selectedColumnIds}
          selectedGroupIds={selectedGroupIds}
          selectedRoomIds={selectedRoomIds}
          selectedRoofIds={selectedRoofIds}
          selectedSectionLineIds={selectedSectionLineIds}
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
        <DrawingTabs project={project} handlers={viewSnapshotTabs} />
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
      <DrawingTabs project={project} handlers={viewSnapshotTabs} />
      {viewType === "perspektive" ? (
        <section className="pane">
          <div className="pane-title">
            {t("content.perspektiveTitle", { name: level.name })}
          </div>
          <Viewport3D
            project={project}
            renderMode={renderMode}
            detail={detail}
            view3d={view3d}
            groundElevation={level.baseElevation ?? 0}
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
          selectedDrawingId={selectedDrawingId}
          selectedDrawingIds={selectedDrawingIds}
          gripHandlers={gripHandlers}
        />
      )}
    </main>
  );
}

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
 * Fremd-Art-Referenzüberlagerung: zeigt jede andere sichtbare Zeichnungsebene,
 * deren KIND vom aktiven Level abweicht (Geschoss/Zeichnung/Schnitt/Ansicht —
 * Auge an + Darstellungsmodus über `floorDisplay`), als nicht-interaktive
 * Kalkierpapier-Unterlage. Gleiche Art (z. B. andere Geschosse im Grundriss)
 * läuft stattdessen über `generateVisibleLevelsPlan` (echte X/Y-Überlagerung
 * im selben Koordinatenraum) — hier geht es um GRUNDSÄTZLICH andere
 * Projektionsachsen (Schnitt/Ansicht: Länge×Höhe statt X×Y), die sich nur als
 * lose, nicht exakt ausgerichtete Referenz überlagern lassen. Schnitte
 * brauchen die asynchrone WASM-Pipeline (computeSection, gecacht je Ebene-ID);
 * Ansichten/Grundrisse/Zeichnungen laufen synchron.
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
  const [sectionOutputs, setSectionOutputs] = useState<Record<string, SectionOutput | null>>({});
  useEffect(() => {
    const sectionLevels = overlayLevels.filter((l) => l.kind === "section");
    if (sectionLevels.length === 0) return;
    let disposed = false;
    void Promise.all(
      sectionLevels.map(async (l) => {
        try {
          return [l.id, await computeSection(project, l)] as const;
        } catch (e) {
          console.warn("render3d-Schnitt (Referenz-Überlagerung) fehlgeschlagen:", e);
          return [l.id, null] as const;
        }
      }),
    ).then((entries) => {
      if (disposed) return;
      setSectionOutputs((prev) => {
        const next = { ...prev };
        for (const [id, out] of entries) next[id] = out;
        return next;
      });
    });
    return () => {
      disposed = true;
    };
  }, [project, overlayLevels]);

  return useMemo(() => {
    const out: Primitive[] = [];
    for (const l of overlayLevels) {
      const greyed = floorDisplay(l.id).greyed;
      let prims: Primitive[];
      if (l.kind === "elevation") {
        prims =
          generateElevationPlan(project, l, { mono, visibleCodes, categoryDisplay })?.primitives ?? [];
      } else if (l.kind === "section") {
        const sOut = sectionOutputs[l.id];
        prims = sOut
          ? generateSectionPlan(sOut, mono, { hiddenLines: l.hiddenLines, visibleCodes, categoryDisplay })
              .primitives
          : [];
      } else {
        // Geschoss ODER freie Zeichnung: dieselbe Grundriss-Pipeline, aber ohne
        // die projektglobalen Zutaten (Kontext-Konturen/Schnittlinien) — die
        // liefert bereits die aktive Ebene selbst (kein Doppel-Zeichnen).
        prims = generatePlan(
          project,
          l.id,
          visibleCodes,
          categoryDisplay,
          detail,
          referenceLines,
          mono,
          false,
          scaleDenominator,
        ).primitives;
      }
      for (const pr of prims) out.push(stripSelectableIds(greyed ? { ...pr, greyed: true } : pr));
    }
    return out;
  }, [overlayLevels, sectionOutputs, project, mono, floorDisplay, visibleCodes, categoryDisplay, detail, referenceLines]);
}

/** Abgeleiteter Grundriss eines Geschosses. */
function LevelPlanView({
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
  selectedWallIds,
  selectedCeilingIds,
  selectedOpeningIds,
  selectedStairIds,
  selectedExtrudedSolidIds,
  selectedColumnIds,
  selectedGroupIds,
  selectedRoomIds,
  selectedRoofIds,
  selectedContextObjectIds,
  selectedSectionLineIds,
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
  selectedDrawingId,
  selectedDrawingIds,
  gripHandlers,
}: {
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
  selectedWallIds: string[];
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedExtrudedSolidIds: string[];
  selectedColumnIds: string[];
  selectedGroupIds: string[];
  selectedRoomIds: string[];
  selectedRoofIds: string[];
  selectedContextObjectIds?: string[];
  selectedSectionLineIds: string[];
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
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
  selectedDrawingId: string | null;
  selectedDrawingIds?: string[];
  gripHandlers: GripHandlers;
}) {
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
  const plan = useMemo(() => {
    // Überlagert ALLE sichtbaren Geschoss-/Zeichnungs-Ebenen derselben Art wie
    // `level` in einem Plan (aktive Ebene farbig, andere je Darstellungsmodus
    // gedimmt/gesperrt — Nutzer-Wunsch "mehrere Geschosse gleichzeitig
    // einschaltbar", s. plan/generatePlan.ts::generateVisibleLevelsPlan).
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
  useEffect(() => {
    pushNativeWalls(project);
  }, [project]);

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
        resetKey={level.id}
        onCursor={onCursor}
        onScale={onScale}
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
        selectedDrawingId={selectedDrawingId}
        selectedDrawingIds={selectedDrawingIds}
        gripHandlers={gripHandlers}
      />
      {/* NACH PlanView gerendert (nicht als box-shadow auf .pane), damit der
          Isolations-Rahmen über der PlanView-SVG sichtbar bleibt. */}
      {groupPath.length > 0 && <div className="pane-isolation-frame" />}
    </section>
  );
}

/**
 * Geschnittene Fenster/Türen in den Schnitt-Plan einsetzen: nach den Cut-
 * Polygonen (liegen in deren Aussparung), vor den Ansichtskanten — die Reihen-
 * folge spielt kaum eine Rolle, da sie sich nicht überdecken.
 */
function withSectionOpenings(plan: Plan, openings: Primitive[]): Plan {
  if (openings.length === 0) return plan;
  return { ...plan, primitives: [...plan.primitives, ...openings] };
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
  selectedWallIds,
  selectedCeilingIds,
  selectedOpeningIds,
  selectedStairIds,
  selectedExtrudedSolidIds,
  selectedColumnIds,
  selectedGroupIds,
  selectedRoomIds,
  selectedRoofIds,
  selectedSectionLineIds,
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
  selectedWallIds: string[];
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedExtrudedSolidIds: string[];
  selectedColumnIds: string[];
  selectedGroupIds: string[];
  selectedRoomIds: string[];
  selectedRoofIds: string[];
  selectedSectionLineIds: string[];
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
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
  selectedDrawingId: string | null;
  selectedDrawingIds?: string[];
  gripHandlers: GripHandlers;
}) {
  // Die Ansicht (kind "elevation") läuft NICHT über den WASM-Schnitt, sondern
  // über den rein TS-seitigen Flächen-Generator (Painter, toElevation.ts) —
  // synchron, kein Lazy-Load. Nur der echte Schnitt braucht die WASM-Pipeline.
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
        ? generateElevationPlan(inputs.project, inputs.level, { mono, visibleCodes, categoryDisplay })
        : null,
    [isElevation, inputs, mono, visibleCodes, categoryDisplay],
  );

  const sectionPlan = useMemo(
    () =>
      !isElevation && output
        ? withSectionOpenings(
            generateSectionPlan(output, mono, {
              hiddenLines: level.hiddenLines,
              visibleCodes,
              categoryDisplay,
            }),
            sectionOpeningPrimitives(inputs.project, inputs.level, visibleCodes, categoryDisplay),
          )
        : null,
    [isElevation, output, mono, level.hiddenLines, visibleCodes, categoryDisplay, inputs],
  );
  const rawPlan = isElevation ? elevationPlan : sectionPlan;
  // Grundriss-Unterlage (Nutzer-Wunsch: "in der Ansicht auch mal einen
  // Grundriss zeigen können"): das in `level.planUnderlayId` gewählte Geschoss
  // AUSGERICHTET unter dem Schnitt/der Ansicht (s. plan/planUnderlay.ts) —
  // nicht mehr jede sichtbare Ebene lose übereinander (die lag in einem
  // fremden Koordinatenraum und verdeckte den Schnitt).
  const underlayFloor = project.drawingLevels.find(
    (l) => l.id === level.planUnderlayId && l.kind === "floor",
  );
  const sectionMinY = rawPlan?.bounds.minY;
  const overlayPrimitives = useMemo(() => {
    if (!underlayFloor || sectionMinY === undefined) return [];
    const floorPlan = generatePlan(
      project,
      underlayFloor.id,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      mono,
      false,
      scaleDenominator,
    );
    return planUnderlayPrimitives(level, floorPlan.primitives, sectionMinY).map(stripSelectableIds);
  }, [underlayFloor, sectionMinY, project, level, visibleCodes, categoryDisplay, detail, referenceLines, mono, scaleDenominator]);
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
      rawPlan && levelMarksEnabled(level) ? levelMarkerPrimitives(project, rawPlan.bounds) : [],
    [rawPlan, level, project],
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
    for (const pr of overlayPrimitives) {
      if (pr.kind === "polygon") for (const p of pr.pts) grow(p.x, p.y);
      else if (pr.kind === "line") { grow(pr.a.x, pr.a.y); grow(pr.b.x, pr.b.y); }
    }
    if (sheetDrawings.primitives.length > 0) {
      const eb = sheetDrawings.bounds;
      grow(eb.minX, eb.minY);
      grow(eb.maxX, eb.maxY);
    }
    for (const pr of marks) if (pr.kind === "line") grow(pr.a.x, pr.a.y);
    // Unterlage zuunterst, Blatt-Zeichnungen obenauf.
    return { ...rawPlan, primitives: [...overlayPrimitives, ...rawPlan.primitives, ...extra], bounds: b };
  }, [rawPlan, overlayPrimitives, sheetDrawings, marks]);
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
        resetKey={level.id}
        onCursor={onCursor}
        onScale={onScale}
        selectedWallIds={selectedWallIds}
        selectedCeilingIds={selectedCeilingIds}
        selectedOpeningIds={selectedOpeningIds}
        selectedStairIds={selectedStairIds}
        selectedExtrudedSolidIds={selectedExtrudedSolidIds}
        selectedColumnIds={selectedColumnIds}
        selectedGroupIds={selectedGroupIds}
        selectedRoomIds={selectedRoomIds}
        selectedRoofIds={selectedRoofIds}
        selectedSectionLineIds={selectedSectionLineIds}
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
        selectedDrawingId={selectedDrawingId}
        selectedDrawingIds={selectedDrawingIds}
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
