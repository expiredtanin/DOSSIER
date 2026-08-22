// Haupt-Viewport-Inhalt (Mitte) — abhängig von aktiver Zeichnungsebene und
// Ansichtstyp. `Content` ist der View-Router: Geschoss→Grundriss/3D,
// Schnitt/Ansicht→SectionPlanView, freie Zeichnung→LevelPlanView. Die beiden
// Plan-Ableitungen (Grundriss bzw. Schnitt/Ansicht) zeichnen dieselbe PlanView.
//
// Extrahiert aus App.tsx (top-level, alles über Props — keine App-Closure).
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useMemo, useState } from "react";

import { t } from "../i18n";
import { formatM } from "../model/types";
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
import { generatePlan, generateSectionPlan } from "../plan/generatePlan";
import type { CategoryDisplayResolver } from "../plan/generatePlan";
import type { RichTextDoc } from "../text/richText";
import { computeSection } from "../plan/toSection";
import type { SectionOutput } from "../plan/toSection";
import { generateElevationPlan } from "../plan/toElevation";
import { pushNativeScene, pushNativeWalls } from "../plan/nativeSync";
import { selectionHighlightLines } from "../plan/toWalls3d";
import { applyGroupDimming } from "../state/groupActions";
import { PlanView } from "../plan/PlanView";
import type {
  GripHandlers,
  GroupableHit,
  HudFieldsState,
  MarqueeSelection,
  PlanSelection,
  PlanViewHandle,
} from "../plan/PlanView";
import { Viewport3D } from "../viewport/Viewport3D";
import type { DisplayResolver, ViewportContextInfo } from "../viewport/Viewport3D";
import type { Pick3dHit } from "../viewport/Wasm3DViewport";
import { DrawingTabs } from "../DrawingTabs";
import type { Drawing } from "../DrawingTabs";
import type { ToolDraft, ToolHandlers, ToolId } from "../tools/types";
import type { DetailLevel, RenderMode, View3d, ViewType } from "../ui/TopBar";

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
  hairline,
  marqueeColor,
  snapColor,
  hoverDivideDelayMs,
  hoverDivideCount,
  renderMode,
  view3d,
  fov,
  grid3dVisible,
  onToggleGrid3d,
  section3d,
  onClearSection3d,
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
  selectedContextObjectIds,
  selectedSectionLineId,
  roomStamp,
  onStampMove,
  onStampEdit,
  onEditDrawingText,
  onEnterGroup,
  groupPath,
  editTextId,
  editTextMinHeightM,
  onCommitTextEdit,
  onCloseTextEdit,
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
  selectedContextObjectIds: string[];
  selectedSectionLineId: string | null;
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
  onStampEdit: (roomId: string) => void;
  onEditDrawingText?: (drawingId: string) => void;
  onEnterGroup?: (hit: GroupableHit) => boolean;
  groupPath: string[];
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
          selectedRoomIds={selectedRoomIds}
          selectedRoofIds={selectedRoofIds}
          selectedSectionLineId={selectedSectionLineId}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
          onEditDrawingText={onEditDrawingText}
          onEnterGroup={onEnterGroup}
          groupPath={groupPath}
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
          selectedRoomIds={selectedRoomIds}
          selectedRoofIds={selectedRoofIds}
          selectedContextObjectIds={selectedContextObjectIds}
          selectedSectionLineId={selectedSectionLineId}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
          onEditDrawingText={onEditDrawingText}
          onEnterGroup={onEnterGroup}
          groupPath={groupPath}
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
            section3d={section3d}
            onClearSection3d={onClearSection3d}
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
          selectedRoomIds={selectedRoomIds}
          selectedRoofIds={selectedRoofIds}
          selectedContextObjectIds={selectedContextObjectIds}
          selectedSectionLineId={selectedSectionLineId}
          roomStamp={roomStamp}
          onStampMove={onStampMove}
          onStampEdit={onStampEdit}
          onEditDrawingText={onEditDrawingText}
          onEnterGroup={onEnterGroup}
          groupPath={groupPath}
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
  selectedRoomIds,
  selectedRoofIds,
  selectedContextObjectIds,
  selectedSectionLineId,
  roomStamp,
  onStampMove,
  onStampEdit,
  onEditDrawingText,
  onEnterGroup,
  groupPath,
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
  hairline: boolean;
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
  selectedRoomIds: string[];
  selectedRoofIds: string[];
  selectedContextObjectIds?: string[];
  selectedSectionLineId: string | null;
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
  onStampEdit: (roomId: string) => void;
  onEditDrawingText?: (drawingId: string) => void;
  onEnterGroup?: (hit: GroupableHit) => boolean;
  groupPath: string[];
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
  // Detailgrad + Referenzlinien fließen in die Plan-Erzeugung ein (Symbole,
  // Schraffuren/Linienfeinheit bzw. Wand-Achslinien).
  const plan = useMemo(() => {
    const p = generatePlan(
      project,
      level.id,
      visibleCodes,
      categoryDisplay,
      detail,
      referenceLines,
      mono,
    );
    // Gruppen-Isolation ("Gruppe betreten"): alles ausserhalb der aktiven
    // Gruppe gedimmt, s. state/groupActions.ts::applyGroupDimming.
    return groupPath.length === 0
      ? p
      : { ...p, primitives: applyGroupDimming(p.primitives, project, groupPath) };
  }, [
    project,
    level.id,
    visibleCodes,
    categoryDisplay,
    detail,
    referenceLines,
    mono,
    groupPath,
  ]);

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
        selectedContextObjectIds={selectedContextObjectIds}
        selectedSectionLineIds={selectedSectionLineId ? [selectedSectionLineId] : []}
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
        marqueeColor={marqueeColor}
        snapColor={snapColor}
        hoverDivideDelayMs={hoverDivideDelayMs}
        hoverDivideCount={hoverDivideCount}
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
  selectedRoomIds,
  selectedRoofIds,
  selectedSectionLineId,
  roomStamp,
  onStampMove,
  onStampEdit,
  onEditDrawingText,
  onEnterGroup,
  groupPath,
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
  hairline: boolean;
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
  selectedRoomIds: string[];
  selectedRoofIds: string[];
  selectedSectionLineId: string | null;
  roomStamp: { roomId: string; anchor: Vec2 } | null;
  onStampMove: (roomId: string, delta: Vec2) => void;
  onStampEdit: (roomId: string) => void;
  onEditDrawingText?: (drawingId: string) => void;
  onEnterGroup?: (hit: GroupableHit) => boolean;
  groupPath: string[];
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

  useEffect(() => {
    if (isElevation) return; // Ansicht: kein WASM-Schnitt (synchroner Generator).
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
  }, [project, level, isElevation]);

  // Ansichts-Plan: gefüllte Fassadenansicht inkl. optionalem Schatten
  // (level.shadows). Liefert null, wenn die Ebene keine Ansichtslinie trägt.
  const elevationPlan = useMemo(
    () => (isElevation ? generateElevationPlan(project, level, { mono }) : null),
    [isElevation, project, level, mono],
  );

  const sectionPlan = useMemo(
    () =>
      !isElevation && output
        ? generateSectionPlan(output, mono, { hiddenLines: level.hiddenLines })
        : null,
    [isElevation, output, mono, level.hiddenLines],
  );
  const rawPlan = isElevation ? elevationPlan : sectionPlan;
  // Gruppen-Isolation ("Gruppe betreten") gilt auch für Schnitt-/Ansichts-
  // Pläne, s. state/groupActions.ts::applyGroupDimming.
  const plan = useMemo(
    () =>
      rawPlan && groupPath.length > 0
        ? { ...rawPlan, primitives: applyGroupDimming(rawPlan.primitives, project, groupPath) }
        : rawPlan,
    [rawPlan, project, groupPath],
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
        selectedSectionLineIds={selectedSectionLineId ? [selectedSectionLineId] : []}
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
        marqueeColor={marqueeColor}
        snapColor={snapColor}
        hoverDivideDelayMs={hoverDivideDelayMs}
        hoverDivideCount={hoverDivideCount}
        selectedDrawingId={selectedDrawingId}
        selectedDrawingIds={selectedDrawingIds}
        gripHandlers={gripHandlers}
      />
      <div className="plan-legend">{t("section.legend", { kind: kindLabel })}</div>
    </section>
  );
}
