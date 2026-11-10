// Rendert einen Plan als SVG. Vektor → unendlich scharf & druckbar.
//
// Schraffuren werden aus der je Polygon aufgelösten HatchStyle-Ressource
// erzeugt (Muster, Maßstab, Winkel, Farbe, Linienstärke). Pro schraffiertem
// Polygon wird ein eigenes <pattern> in <defs> definiert, damit Maßstab/Winkel/
// Farbe variieren können.

import { forwardRef, useEffect, useMemo, useState } from "react";
import type { ComponentProps, CSSProperties } from "react";
import type { PlanImage, Primitive } from "../../core";
import { planLineEndsProps } from "../../core";
import type { Vec2 } from "../../model/types";
import { t } from "../../i18n";
import { docFromText } from "../../text/richText";
import { contentFontBaselineFromTop, TEXT_LINE_HEIGHT_MULT } from "../../text/fontMetrics";
import { textFrameCorners } from "../../text/textFrame";
import { RichTextEditor } from "../../editors/RichTextEditor";
import { LiveMeet, LiveValue } from "./planView/liveMeet";
import { DEFAULT_MARQUEE_COLOR, DEFAULT_SNAP_COLOR } from "../../theme/accents";
import { type ViewBox__plan_planView_geometry as ViewBox, PX_PER_M, PAD, toScreen, meetScale, defaultViewFor } from "../../core";
import {
  polyUsesPattern,
  HatchPattern,
  buildDrawingRuns,
  DrawingRunShape,
  PrimitiveShape,
  greyColor,
} from "./planView/primitives";
import { DraftOverlay } from "./planView/overlays";
import { visibleGripIndices } from "./planView/gripCull";
import { localViewBoxAttr } from "./planView/overlayOrigin";
import { PlanRulers } from "./planView/PlanRulers";
import { PlanGrid } from "./planView/PlanGrid";
import { indexedInRegion } from "../../core";
import { planTextEntries } from "../../core";
import { EMPTY_SELECTION, single } from "../../state/selection";
import { useCursorValue, type CursorStore } from "../../state/cursorStore";
import type { HatchedPoly, PlanViewHandle, PlanViewProps } from "./planView/types";
import { IS_MAC } from "./planView/constants";
import { usePlanEngine } from "./planView/usePlanEngine";
import { usePlanCoords } from "./planView/usePlanCoords";
import { usePlanPicking } from "./planView/usePlanPicking";
import { usePlanPointer } from "./planView/usePlanPointer";
import { usePlanPickCycle } from "./planView/usePlanPickCycle";
import { usePlanZoomInput } from "./planView/usePlanZoomInput";
import { usePlanHighlights } from "./planView/usePlanHighlights";

/**
 * Feld-Status der Befehlszeile fürs Cursor-HUD (Tab-Feld-Zyklus §2.7) — Typ
 * lebt in `tools/hudFormat.ts` (dort auch von der 3D-Ansicht genutzt);
 * hier nur re-exportiert (bestehende Importe aus `./PlanView` bleiben gültig).
 */
export type { HudFieldsState } from "../../tools/hudFormat";
// [165] Typen und Konstanten liegen in `planView/types.ts` bzw. `planView/constants.ts`.
export type {
  BodyTarget,
  GripHandlers,
  GroupableHit,
  MarqueeSelection,
  PickCandidate,
  PlanSelection,
  PlanViewHandle,
  PlanViewProps,
} from "./planView/types";

/** Lineale, die den Cursor selbst abonnieren — nur sie rendern bei Mausbewegung. */
function LiveRulers({ store, ...rest }: Omit<ComponentProps<typeof PlanRulers>, "cursor"> & { store: CursorStore }) {
  return <PlanRulers {...rest} cursor={useCursorValue(store)} />;
}

/**
 * Baut die CSS-`filter`-Kette für ein Hintergrund-Luftbild aus
 * `ContextImage.filters` (Sättigung/Helligkeit/Kontrast/Graustufen). `null`
 * bei fehlenden/neutralen Werten (kein `style`-Attribut nötig — vermeidet
 * unnötige Re-Renders/DOM-Diffs für das Gros der Bilder ohne Korrektur).
 * Reihenfolge (saturate→brightness→contrast→grayscale) ist beliebig, da jeder
 * Filter unabhängig auf den vorherigen Zustand wirkt.
 */
export function cssImageFilter(filters: PlanImage["filters"]): string | undefined {
  if (!filters) return undefined;
  const { saturation = 1, brightness = 1, contrast = 1, grayscale = 0 } = filters;
  if (saturation === 1 && brightness === 1 && contrast === 1 && grayscale === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (saturation !== 1) parts.push(`saturate(${saturation})`);
  if (brightness !== 1) parts.push(`brightness(${brightness})`);
  if (contrast !== 1) parts.push(`contrast(${contrast})`);
  if (grayscale !== 0) parts.push(`grayscale(${grayscale})`);
  return parts.join(" ");
}

export const PlanView = forwardRef<PlanViewHandle, PlanViewProps>(
  function PlanView(
    {
      plan: planRaw,
      resetKey,
      onCursor,
      onScale,
      onSelect,
      describePick,
      onPickHint,
      onMarquee,
      onSegmentCut,
      onContextMenu,
      selection = EMPTY_SELECTION,
      sheetBodies = false,
      roomStamp,
      onStampMove,
      onStampEdit,
      onEditDrawingText,
      onEnterGroup,
      editTextId,
      editTextMinHeightM,
      onCommitTextEdit,
      onCloseTextEdit,
      onOpenSectionLevel,
      activeTool,
      toolInputActive,
      toolHandlers,
      showRulers = true,
      showGrid = false,
      hudFields,
      grips,
      gripHandleLines,
      edgeGrips,
      hairline,
      gripHandlers,
      marqueeColor = DEFAULT_MARQUEE_COLOR,
      snapColor = DEFAULT_SNAP_COLOR,
      hoverDivideDelayMs = 300,
      hoverDivideCount = 2,
      backdrop,
      units,
      fitBounds,
    },
    ref,
  ) {
  const {
    walls: selectedWallIds,
    ceilings: selectedCeilingIds,
    openings: selectedOpeningIds,
    stairs: selectedStairIds,
    rooms: selectedRoomIds,
    roofs: selectedRoofIds,
    contextObjects: selectedContextObjectIds,
    sectionLines: selectedSectionLineIds,
    solids: selectedExtrudedSolidIds,
    columns: selectedColumnIds,
    groups: selectedGroupIds,
    drawings: selectedDrawingIds,
    site: selectedSite,
    trees: selectedTreeIds,
  } = selection;
  const selectedDrawingId = single(selection, "drawings");
  // Linke Maustaste liegt beim Werkzeug/der Transformation, wenn App das meldet
  // (toolInputActive) bzw. — fallback — ein Zeichenwerkzeug aktiv ist.
  const inputActive = toolInputActive ?? (!!activeTool && activeTool !== "select");
  const toolActive = inputActive && !!toolHandlers;
  // Editier-Griffe sind nur im Auswahl-Werkzeug aktiv.
  const gripsActive = !toolActive && !!grips && grips.length > 0 && !!gripHandlers;
  // Kanten-Griffe nur aktiv, wenn auch die Eckpunkt-Griffe aktiv sind.
  const edgeGripsActive = gripsActive && !!edgeGrips && edgeGrips.length > 0;
  // Eingepasste Standard-Ansicht aus den AKTUELLEN Bounds, über die fixe
  // toScreen-Abbildung. Reset-/Einpassen-Ziel + Bezug für die Zoom-Grenzen; wird
  // NICHT automatisch angewandt (nur bei resetKey-Wechsel und „Einpassen").
  const defaultView = useMemo<ViewBox>(() => {
    const b = fitBounds ?? planRaw.bounds;
    // Fester Einpass-Bereich (Blatt): Rand relativ zu seiner Grösse statt der festen Modell-Marge.
    const pad = fitBounds ? Math.max(b.maxX - b.minX, b.maxY - b.minY) * PX_PER_M * 0.04 : PAD;
    return defaultViewFor(b, pad, fitBounds ? 0 : undefined);
  }, [planRaw, fitBounds]);

  // Aktueller Ausschnitt; treibt die viewBox des SVG. Initial = eingepasst.
  const [view, setView] = useState<ViewBox>(defaultView);
  // Ausschnitt NUR bei Plan-/Geschoss-Wechsel (resetKey) auf „eingepasst"
  // zurücksetzen — NICHT bei jeder Bounds-Änderung durch Editieren (sonst
  // „wandert" die Ansicht beim Verschieben/Löschen mit). `defaultView` ist beim
  // resetKey-Wechsel bereits frisch (neues Geschoss), daher direkt anwendbar.
  useEffect(() => {
    setView(defaultView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
  // [165] Renderer-Anbindung: Pick-Index, Engine-Wahl (nativ/WASM/SVG), Plan-Aufbereitung, Culling, Papier-Massstab, GL-Effekte.
  const {
    getPick,
    svgRef,
    canvasRef,
    wantNative,
    wantWasm,
    nativeHook,
    renderGl,
    wantGpu,
    hasBgImages,
    useGpuRenderer,
    plan,
    stampAt,
    getUnderlay,
    getUnderlayIndex,
    getUnderlayIds,
    svgCandidates,
    cullState,
    paperScale,
    setPaperScale,
    syncDashVar,
    viewRef,
    overlayOriginRef,
    overlayOrigin,
    toLocal,
    meetStore,
    viewStore,
    defaultViewRef,
    toScreenRef,
    planRef,
    paperScaleForGl,
    textScaleForGl,
  } = usePlanEngine({
    editTextId,
    planRaw,
    backdrop,
    roomStamp,
    defaultView,
    view,
    hairline,
    onScale,
    resetKey,
  });
  // [165] Steuerhandle, Zieh-Zustände, Koordinaten-Umrechnung und Griff-Treffer.
  const {
    drag,
    dragging,
    setDragging,
    marquee,
    marqueeRect,
    setMarqueeRect,
    gripDrag,
    edgeDrag,
    moveDrag,
    stampDrag,
    lastClickRef,
    stampHandleAt,
    selected,
    setSelected,
    measure,
    clientToView,
    viewToModel,
    rawModelAt,
    vbToClient,
    clientMap,
    gripAt,
    EDGE_GRIP_H_PX,
    EDGE_GRIP_HALF_PX,
    screenNormal,
    edgeGripAt,
    currentPxPerMeter,
    toolMods,
    rulerCursor,
    setRulerCursor,
    reportCursor,
  } = usePlanCoords({
    gripHandlers,
    ref,
    setView,
    defaultViewRef,
    planRef,
    toScreenRef,
    viewRef,
    svgRef,
    setPaperScale,
    roomStamp,
    stampAt,
    plan,
    canvasRef,
    view,
    grips,
    edgeGrips,
    onCursor,
  });
  // [165] Treffer-Abfragen (Bauteile, 2D-Elemente, Lage, Bäume), Hover-Teilpunkte, gegriffener Körper, Marquee-Treffer.
  const {
    hitTest,
    anyGroupableHit,
    pickDrawing,
    pickDrawingText,
    pickDrawingImage,
    pickOpening,
    pickStair,
    pickRoom,
    pickRoof,
    pickSectionLine,
    pickSiteAt,
    pickTree,
    pickContextObject,
    pickExtrudedSolid,
    pickColumn,
    hoverDivideSeg,
    updateHoverDivide,
    clearHoverDivide,
    grabbedBody,
    marqueeHitAll,
  } = usePlanPicking({
    clientToView,
    view,
    getPick,
    viewToModel,
    plan,
    currentPxPerMeter,
    rawModelAt,
    getUnderlayIndex,
    clientMap,
    hoverDivideDelayMs,
    toolActive,
    sheetBodies,
    selectedOpeningIds,
    selectedCeilingIds,
    selectedStairIds,
    selectedWallIds,
    selectedDrawingIds,
    selectedDrawingId,
    getUnderlayIds,
    getUnderlay,
  });
  // [165] Zeiger-Eingabe: Pointer-Down/-Move, imperativer Pan, Drag-Drosselung, Standard-Auswahl.
  const {
    onPointerDown,
    dragMovePending,
    dragMoveRaf,
    panPending,
    overlayHeavyRef,
    enqueuePan,
    gripK,
    commitPan,
    flushDragMove,
    onPointerMove,
    defaultPick,
  } = usePlanPointer({
    gripDrag,
    gripHandlers,
    edgeDrag,
    toolActive,
    onStampEdit,
    lastClickRef,
    stampHandleAt,
    pickRoom,
    drag,
    view,
    setDragging,
    onSegmentCut,
    pickDrawing,
    clientToView,
    viewToModel,
    toolHandlers,
    rawModelAt,
    currentPxPerMeter,
    toolMods,
    roomStamp,
    onStampMove,
    stampDrag,
    stampAt,
    gripsActive,
    gripAt,
    grips,
    edgeGripsActive,
    edgeGripAt,
    grabbedBody,
    moveDrag,
    marquee,
    svgRef,
    canvasRef,
    overlayOriginRef,
    viewRef,
    meetStore,
    syncDashVar,
    viewStore,
    wantNative,
    renderGl,
    paperScaleForGl,
    textScaleForGl,
    defaultView,
    setView,
    reportCursor,
    setMarqueeRect,
    updateHoverDivide,
    measure,
    useGpuRenderer,
    hitTest,
    plan,
    pickSectionLine,
    pickOpening,
    pickColumn,
    pickExtrudedSolid,
    pickTree,
    pickStair,
    pickRoof,
    pickSiteAt,
    pickContextObject,
  });
  // [165] Durchschalten übereinanderliegender Objekte (Liste, Zyklus) und Pointer-Up.
  const {
    pickList,
    setPickList,
    hoverPick,
    setHoverPick,
    cycleRef,
    applyCandidate,
    endDrag,
  } = usePlanPickCycle({
    selection,
    onPickHint,
    view,
    planRaw,
    resetKey,
    getPick,
    rawModelAt,
    getUnderlayIds,
    currentPxPerMeter,
    plan,
    getUnderlayIndex,
    pickDrawingText,
    pickDrawingImage,
    describePick,
    pickOpening,
    pickColumn,
    pickExtrudedSolid,
    pickStair,
    pickRoom,
    pickRoof,
    pickTree,
    pickSiteAt,
    pickContextObject,
    pickSectionLine,
    onSelect,
    setSelected,
    defaultPick,
    clientToView,
    viewToModel,
    svgRef,
    dragMoveRaf,
    gripDrag,
    edgeDrag,
    dragMovePending,
    gripHandlers,
    stampDrag,
    moveDrag,
    flushDragMove,
    toolActive,
    toolHandlers,
    toolMods,
    marquee,
    onMarquee,
    marqueeHitAll,
    setMarqueeRect,
    drag,
    commitPan,
    setDragging,
  });
  // [165] Mausrad-Zoom, Doppelklick, Kontextmenü.
  const {
    onWheel,
    onDoubleClick,
    onContextMenuHandler,
  } = usePlanZoomInput({
    clientToView,
    defaultView,
    svgRef,
    useGpuRenderer,
    panPending,
    viewRef,
    canvasRef,
    enqueuePan,
    commitPan,
    setView,
    toolActive,
    toolHandlers,
    onEnterGroup,
    anyGroupableHit,
    onEditDrawingText,
    pickDrawingText,
    onStampEdit,
    stampHandleAt,
    pickRoom,
    onOpenSectionLevel,
    pickSectionLine,
    onContextMenu,
    view,
    viewToModel,
  });
  // [165] Hervorhebungen der Auswahl und des Hover-Treffers.
  const {
    highlightPolys,
    highlightDrawPrims,
    highlightDrawPath,
    highlightTextPath,
    highlightCeilingPolys,
    highlightOpeningPrims,
    highlightStairPrims,
    highlightRoomPolys,
    highlightRoofPolys,
    highlightContextObjectPolys,
    highlightSectionLinePolys,
    highlightExtrudedSolidPolys,
    highlightColumnPolys,
    hoverPrims,
  } = usePlanHighlights({
    getPick,
    selectedWallIds,
    selected,
    plan,
    selectedDrawingIds,
    getUnderlayIds,
    editTextId,
    useGpuRenderer,
    wantNative,
    nativeHook,
    toLocal,
    overlayHeavyRef,
    selectedCeilingIds,
    selectedOpeningIds,
    selectedStairIds,
    selectedRoomIds,
    selectedRoofIds,
    selectedContextObjectIds,
    selectedSite,
    selectedTreeIds,
    selectedSectionLineIds,
    selectedExtrudedSolidIds,
    selectedColumnIds,
    hoverPick,
  });

  // Ist eine GRUPPE gewählt (statt einzelner Elemente), zeigt die Auswahl NUR
  // eine einfache Bounding-Box mit vier Eckpunkten statt jedes einzelnen
  // Mitglieds-Umrisses (Nutzer-Wunsch, Vectorworks-Vorbild: „einfach vier
  // Aussenpunkte zeigen") — vereint dieselben Hervorhebungs-Listen, die sonst
  // einzeln gezeichnet würden.
  const groupBBox = useMemo(() => {
    if (!selectedGroupIds || selectedGroupIds.length === 0) return null;
    const pts: Vec2[] = [];
    for (const poly of highlightPolys) pts.push(...poly.pts);
    for (const poly of highlightCeilingPolys) pts.push(...poly.pts);
    for (const poly of highlightRoomPolys) pts.push(...poly.pts);
    for (const poly of highlightRoofPolys) pts.push(...poly.pts);
    for (const poly of highlightColumnPolys) pts.push(...poly.pts);
    const fromLineOrPoly = (p: { kind: string; a?: Vec2; b?: Vec2; from?: Vec2; to?: Vec2; center?: Vec2; pts?: Vec2[] }) => {
      if (p.kind === "line" && p.a && p.b) pts.push(p.a, p.b);
      else if (p.kind === "arc" && p.from && p.to) pts.push(p.from, p.to);
      else if (p.pts) pts.push(...p.pts);
    };
    for (const p of highlightDrawPrims) fromLineOrPoly(p);
    for (const p of highlightOpeningPrims) fromLineOrPoly(p);
    for (const p of highlightStairPrims) fromLineOrPoly(p);
    if (pts.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }, [
    selectedGroupIds,
    highlightPolys,
    highlightCeilingPolys,
    highlightRoomPolys,
    highlightRoofPolys,
    highlightColumnPolys,
    highlightDrawPrims,
    highlightOpeningPrims,
    highlightStairPrims,
  ]);

  // Zusammenhängende 2D-Zeichen-Linien (gleiche drawingId + Stil) zu Zügen
  // bündeln, damit sie als EIN <polyline>/<polygon> gezeichnet werden können —
  // so gehren dicke Ecken sauber (kein Butt-Cap-Sprung). generatePlan schiebt die
  // Kanten eines Elements aufeinanderfolgend + End-an-Start verkettet ein, daher
  // genügt greedy-Anhängen benachbarter Segmente.
  // Nur der reine SVG-Pfad zeichnet die gebündelten Linienzüge; bei GPU (WebGL/
  // WASM) übernimmt die GPU-Ebene — dort wäre der Durchgang über alle Primitive
  // (bei Kataster 3,7 Mio.) reine Verschwendung bei jeder Plan-Änderung.
  const drawingRuns = useMemo(
    () => (useGpuRenderer ? [] : buildDrawingRuns(plan.primitives)),
    [plan, useGpuRenderer],
  );

  // Pro Polygon mit Linien-/Kreuz-Schraffur ein eigenes <pattern> sammeln.
  // Vollfüllung ("solid") und "none" brauchen kein Muster. Gedimmte Polygone
  // (greyed) bekommen HIER separat dieselbe Grau-Umfärbung wie `greyedCopy` in
  // primitives.tsx — die <pattern>-Definition ist eine eigene, vom Primitiv
  // losgelöste Ressource (nur über `url(#hatch-i)` referenziert) und würde
  // sonst weiterhin in der ORIGINAL-Bauteilfarbe erscheinen.
  const hatched = useMemo(() => {
    const list: HatchedPoly[] = [];
    // Mit GPU (nativ oder WASM) zeichnet das SVG nur Texte (keine Polygone → keine Muster).
    if (useGpuRenderer) return list;
    plan.primitives.forEach((p, i) => {
      if (p.kind === "polygon" && polyUsesPattern(p.hatch)) {
        // Verlauf-Schraffuren tragen ihre eigentliche Farbe in `gradient.color1/
        // color2` (nicht in `hatch.color`, das dort ungenutzt ist) — beide
        // Stops müssen separat eingegraut werden, sonst bliebe ein gedimmtes
        // Bauteil mit einer Verlauf-Schraffur trotzdem knallfarbig.
        const hatch = p.greyed
          ? {
              ...p.hatch,
              color: greyColor(p.hatch.color) ?? p.hatch.color,
              gradient: p.hatch.gradient && {
                ...p.hatch.gradient,
                color1: greyColor(p.hatch.gradient.color1) ?? p.hatch.gradient.color1,
                color2: greyColor(p.hatch.gradient.color2) ?? p.hatch.gradient.color2,
              },
            }
          : p.hatch;
        list.push({ patternId: `hatch-${i}`, hatch });
      }
    });
    return list;
  }, [plan, useGpuRenderer, wantWasm]);

  // `cullState` (s. o.) reduziert bei sehr vielen Primitiven die Menge VOR
  // dem eigentlichen JSX-Mapping — gleiche Eigenschaft wie zuvor (hängt NICHT
  // direkt an `view`, nur am per Hysterese gepufferten `cullState`), behält
  // aber den URSPRÜNGLICHEN Index `i` (Auswahl/Hit-Testing + Hatch-Pattern-IDs
  // indizieren in `plan.primitives[i]`, s. `cullPrimitives.ts`). Ohne aktives
  // Culling (`cullState === null`, der Normalfall) identisch zu vorher.
  const culledIndexed = useMemo(() => {
    if (!cullState) return svgCandidates;
    return indexedInRegion(svgCandidates, cullState.region, cullState.minTextHeightVb);
  }, [svgCandidates, cullState]);

  // Perf: die Primitiv-Elemente hängen NUR an `culledIndexed` (+ Haarlinie/
  // Massstab), NICHT an `view` direkt. Ohne Memo würde jedes Schwenken/Zoomen
  // (das nur die viewBox ändert) den gesamten Element-Baum neu erzeugen und
  // React ihn komplett abgleichen — auf WebKitGTK (Tauri-Desktop) der spürbare
  // Ruckler. Memoisiert bleibt der Baum referenzstabil, Pan/Zoom aktualisiert
  // nur noch das viewBox-Attribut (ausser `cullState` wechselt, s. o.).
  const primitiveEls = useMemo(
    () =>
      // `culledIndexed` enthält nur, was das SVG selbst zeichnen muss (s.
      // `svgCandidates`: bei GL nur Text, bei WASM nur `drawingText`, ohne GPU
      // alles ausser den gebündelten 2D-Zeichenlinien). ZUSÄTZLICH das gerade im
      // Inline-Editor offene Text-Element NIE statisch mitzeichnen — der Editor
      // bricht nach echter Font-Metrik um, das SVG nach geschätzter Zeichenbreite;
      // die Abweichung liess sonst Reste des statischen Texts sichtbar.
      culledIndexed.map(({ p, i }) =>
        p.kind === "drawingText" && p.drawingId === editTextId ? null : (
          <PrimitiveShape
            key={i}
            p={p}
            index={i}
            toScreen={toLocal}
            hairline={!!hairline}
            paperScale={paperScale}
          />
        ),
      ),
    [culledIndexed, hairline, paperScale, editTextId, toLocal],
  );
  const drawingRunEls = useMemo(
    () =>
      // Bei aktivem GL übernimmt die WebGL-Ebene die 2D-Zeichenlinien.
      useGpuRenderer
        ? []
        : drawingRuns.map((run, i) => (
            <DrawingRunShape
              key={`run-${i}`}
              run={run}
              toScreen={toLocal}
              hairline={!!hairline}
              paperScale={paperScale}
            />
          )),
    [drawingRuns, hairline, paperScale, useGpuRenderer, toLocal],
  );

  return (
    // Flex-Passthrough (wie das frühere .plan-svg direkt): flex:1 + min-height:0,
    // damit die Fläche in WebKitGTK/Tauri NICHT auf Null-Höhe kollabiert (was
    // height:100% dort täte). display:flex, damit das innere SVG (flex:1) füllt.
    <div
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        width: "100%",
        display: "flex",
      }}
    >
      {/* WebGL2-GPU-Ebene: liegt HINTER dem SVG (z-index 0). Zeichnet die schwere
          Geometrie (Poché/Linien/Bögen); pointer-events aus, damit Klicks das SVG
          darüber erreichen. An `wantGpu` (Absicht) montiert — NICHT an `useGpuRenderer`
          (=wantGpu&&glReady), sonst könnte GL nie initialisieren (Canvas fehlt →
          glReady bleibt false → Deadlock). Bei WebGL-Fehler bleibt es leer hinten
          und der volle SVG-Pfad übernimmt sichtbar. NICHT montiert, wenn ein
          Luftbild aktiv ist — dann rendert der SVG-Pfad alles inkl. Bild-Ebene. */}
      {wantGpu && !hasBgImages && !backdrop && (
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            zIndex: 0,
            pointerEvents: "none",
          }}
        />
      )}
      {/* SVG-Ebene: bei GL transparent DARÜBER (Text/Griffe/Snap/Vorschau, scharf +
          DOM-Hit-Test); ohne GL der vollständige Renderer (Fallback). */}
      <svg
        ref={svgRef}
        className="plan-svg"
        viewBox={localViewBoxAttr(view, overlayOrigin)}
        data-origin-x={overlayOrigin.x}
        data-origin-y={overlayOrigin.y}
        data-engine={useGpuRenderer ? (wantNative ? "native" : "wasm") : "svg"}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => { setRulerCursor(null); onCursor?.(null); clearHoverDivide(); }}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenuHandler}
        // Maus-Schema: MITTE schwenkt (grabbing), sonst Standard-Cursor (LINKS
        // wählt aus). touchAction:none, damit das Schwenken nicht scrollt.
        style={{
          position: useGpuRenderer ? "absolute" : undefined,
          inset: useGpuRenderer ? 0 : undefined,
          zIndex: useGpuRenderer ? 1 : undefined,
          width: useGpuRenderer ? "100%" : undefined,
          height: useGpuRenderer ? "100%" : undefined,
          // Bei GL transparent, damit die WebGL-Ebene dahinter durchscheint.
          background: useGpuRenderer ? "transparent" : undefined,
          cursor: dragging
            ? "grabbing"
            : toolActive || marqueeRect
              ? "crosshair"
              : "default",
          touchAction: "none",
        }}
      >
      <defs>
        {hatched.map((h) => (
          <HatchPattern
            key={h.patternId}
            id={h.patternId}
            hatch={h.hatch}
            hairline={!!hairline}
            paperScale={paperScale}
          />
        ))}
      </defs>
      {/* Zeichenblatt-Hintergrund: deckt den aktuellen Ausschnitt (viewBox)
          vollständig — unabhängig von den Modell-Bounds (fixer Ursprung). Bei
          aktivem GL löscht die WebGL-Ebene das Blatt → hier transparent halten
          (bleibt aber Klick-/Pan-Trefferfläche für Leerraum). */}
      <rect
        x={view.x - overlayOrigin.x}
        y={view.y - overlayOrigin.y}
        width={view.w}
        height={view.h}
        className={useGpuRenderer ? undefined : "plan-bg"}
        fill={useGpuRenderer ? "transparent" : undefined}
      />
      {/* Sichtbares Hintergrund-Raster (rein visuell, unabhängig vom Fang) —
          MUSS hinter Luftbildern/Geometrie liegen, sonst überdeckt es die
          Zeichnung. */}
      {showGrid && (
        <PlanGrid
          vb={{ x0: view.x, y0: view.y, w: view.w, h: view.h }}
          origin={overlayOrigin}
          pxPerMeter={currentPxPerMeter()}
        />
      )}
      {backdrop?.(overlayOrigin, currentPxPerMeter())}
      {/* Georeferenzierte Luftbilder ZWISCHEN Blatt-Hintergrund und Geometrie:
          Modell-Meter × PX_PER_M mit negierter y-Achse (s. toScreen) → Bild-Norden
          (max.y) oben bei y=−max.y·PX; das Bild zeichnet natürlich von oben (kein
          Flip). Nur im SVG-Pfad relevant (bei Luftbild ist GPU deaktiviert). */}
      {hasBgImages && plan.backgroundImages!.map((img) => {
        const w = (img.max.x - img.min.x) * PX_PER_M;
        const h = (img.max.y - img.min.y) * PX_PER_M;
        if (w <= 0 || h <= 0) return null;
        const filter = cssImageFilter(img.filters);
        return (
          <image
            key={img.id}
            href={img.src}
            x={img.min.x * PX_PER_M - overlayOrigin.x}
            y={-img.max.y * PX_PER_M - overlayOrigin.y}
            width={w}
            height={h}
            opacity={img.opacity}
            style={filter ? { filter } : undefined}
            preserveAspectRatio="none"
            pointerEvents="none"
          />
        );
      })}
      {/* 2D-Zeichen-Linien mit drawingId werden gemergt (drawingRuns) als EIN Zug
          gezeichnet → gehrte Ecken statt Butt-Cap-Stufe; im Memo übersprungen. */}
      {/* Linienenden und -ecken des Projekts ([146], `Plan.lineEnds`) für alle Plan-Striche. */}
      <g {...planLineEndsProps(plan.lineEnds)}>
      {primitiveEls}
      {/* Zusammenhängende 2D-Zeichen-Linienzüge als EIN <polyline>/<polygon>:
          CAD-typische Gehrung an den Ecken (stroke-linejoin), keine Stufe bei
          dicken Linien. Nach der Haupt-Ebene gezeichnet (2D liegt ohnehin oben). */}
      {drawingRunEls}
      </g>
      {/* Ist eine GRUPPE gewählt, ersetzt die Bounding-Box unten die einzelnen
          Mitglieds-Hervorhebungen (s. `groupBBox`) — dieser ganze Block bleibt
          dann aus. */}
      {!groupBBox && (
      <>
      {/* Auswahl-Hervorhebung: alle Bänder der gewählten Wand (bzw. das lokal
          getroffene Polygon) mit Akzentkontur überzeichnen. */}
      {highlightPolys.map((poly, i) => (
        <polygon
          key={`sel-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toLocal)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Decken (Akzentkontur). */}
      {highlightCeilingPolys.map((poly, i) => (
        <polygon
          key={`selc-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toLocal)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Räume (Akzentkontur der Fläche). */}
      {highlightRoomPolys.map((poly, i) => (
        <polygon
          key={`selrm-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toLocal)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Dächer (Traufe-Umriss). */}
      {highlightRoofPolys.map((poly, i) => (
        <polygon
          key={`selrf-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toLocal)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Kontext-Objekte (Bbox-Pick-Band). */}
      {highlightContextObjectPolys.map((poly, i) => (
        <polygon
          key={`selctx-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toLocal)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Schnitt-/Ansichtslinie (Pick-Band). */}
      {highlightSectionLinePolys.map((poly, i) => (
        <polygon
          key={`selsl-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toLocal)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten extrudierten Körper (truck-Integration). */}
      {highlightExtrudedSolidPolys.map((poly, i) => (
        <polygon
          key={`selex-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toLocal)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Auswahl-Hervorhebung der gewählten Stützen (Tragwerk). */}
      {highlightColumnPolys.map((poly, i) => (
        <polygon
          key={`selcol-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toLocal)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Hervorhebung der selektierten Öffnungen (Fenster/Tür-Symbole). */}
      {highlightOpeningPrims.map((p, i) =>
        p.kind === "line" ? (
          <line
            key={`selo-${i}`}
            className="plan-sel-draw"
            x1={toLocal(p.a).x}
            y1={toLocal(p.a).y}
            x2={toLocal(p.b).x}
            y2={toLocal(p.b).y}
            pointerEvents="none"
          />
        ) : p.kind === "arc" ? (
          <line
            key={`selo-${i}`}
            className="plan-sel-draw"
            x1={toLocal(p.from).x}
            y1={toLocal(p.from).y}
            x2={toLocal(p.to).x}
            y2={toLocal(p.to).y}
            pointerEvents="none"
          />
        ) : (
          <polygon
            key={`selo-${i}`}
            className="plan-sel-draw"
            points={p.pts
              .map(toLocal)
              .map((s) => `${s.x},${s.y}`)
              .join(" ")}
            pointerEvents="none"
          />
        ),
      )}
      {/* Hervorhebung der selektierten Treppen (Tritte + Symbollinien). */}
      {highlightStairPrims.map((p, i) =>
        p.kind === "line" ? (
          <line
            key={`selst-${i}`}
            className="plan-sel-draw"
            x1={toLocal(p.a).x}
            y1={toLocal(p.a).y}
            x2={toLocal(p.b).x}
            y2={toLocal(p.b).y}
            pointerEvents="none"
          />
        ) : (
          <polygon
            key={`selst-${i}`}
            className="plan-selected"
            points={p.pts
              .map(toLocal)
              .map((s) => `${s.x},${s.y}`)
              .join(" ")}
            pointerEvents="none"
          />
        ),
      )}
      {/* Hervorhebung der selektierten 2D-Zeichenelemente (Akzentkontur). */}
      {highlightDrawPath && (
        <path className="plan-sel-draw" d={highlightDrawPath} pointerEvents="none" />
      )}
      {/* Auswahl-Rahmen für Text-Objekte (geschätzte Box, kein echter Umriss
          wie bei Linie/Polygon — s. `text/textFrame.ts` `textFrameCorners`). Gestrichelt
          statt durchgezogen wie `.plan-sel-draw`, um sichtbar zu machen: das
          ist eine SCHÄTZUNG, keine exakt nachgezeichnete Geometrie. */}
      {highlightTextPath && (
        <path className="plan-sel-text-frame" d={highlightTextPath} pointerEvents="none" />
      )}
      </>
      )}
      {/* Gruppen-Auswahl: nur eine Bounding-Box mit vier Eckpunkten (kein
          Umriss jedes einzelnen Mitglieds) — s. `groupBBox`. */}
      {groupBBox && (<LiveMeet store={meetStore} base={meetScale(view, canvasRef.current ?? svgRef.current) ?? 1}>{(meet) => {
        const c1 = toLocal({ x: groupBBox.minX, y: groupBBox.minY });
        const c2 = toLocal({ x: groupBBox.maxX, y: groupBBox.minY });
        const c3 = toLocal({ x: groupBBox.maxX, y: groupBBox.maxY });
        const c4 = toLocal({ x: groupBBox.minX, y: groupBBox.maxY });
        const size = (4 * gripK(meet)) / meet;
        const corners = [c1, c2, c3, c4];
        return (
          <>
            <polygon
              className="plan-group-bbox"
              points={corners.map((s) => `${s.x},${s.y}`).join(" ")}
              pointerEvents="none"
            />
            {corners.map((s, i) => (
              <circle
                key={`gbb-${i}`}
                className="plan-grip plan-group-bbox-corner"
                cx={s.x}
                cy={s.y}
                r={size}
                pointerEvents="none"
              />
            ))}
          </>
        );
      }}</LiveMeet>)}
      {/* Vorschau beim Überfahren der Objekt-Liste (Cmd/Strg+Klick): das Objekt
          wird im Plan hervorgehoben, ohne die Auswahl zu ändern. */}
      {hoverPrims.length > 0 && (
        <g className="plan-hover-pick" pointerEvents="none">
          {hoverPrims.map((p, i) => {
            const key = `hp-${i}`;
            const pts = (list: Vec2[]) => list.map(toLocal).map((q) => `${q.x},${q.y}`).join(" ");
            switch (p.kind) {
              case "line":
                return <line key={key} x1={toLocal(p.a).x} y1={toLocal(p.a).y} x2={toLocal(p.b).x} y2={toLocal(p.b).y} />;
              case "arc":
                return <line key={key} x1={toLocal(p.from).x} y1={toLocal(p.from).y} x2={toLocal(p.to).x} y2={toLocal(p.to).y} />;
              case "polygon":
                return <polygon key={key} className="plan-hover-fill" points={pts(p.pts)} />;
              case "drawingCircle": {
                const c = toLocal(p.center);
                return <circle key={key} cx={c.x} cy={c.y} r={p.r * PX_PER_M} />;
              }
              case "drawingArc": {
                const TAU = Math.PI * 2;
                const sweep = (((p.a1 - p.a0) % TAU) + TAU) % TAU || TAU;
                const arcPts: Vec2[] = [];
                for (let k = 0; k <= 48; k++) {
                  const a = p.a0 + (sweep * k) / 48;
                  arcPts.push({ x: p.center.x + p.r * Math.cos(a), y: p.center.y + p.r * Math.sin(a) });
                }
                return <polyline key={key} points={pts(arcPts)} />;
              }
              case "drawingText":
                return <polygon key={key} points={pts(textFrameCorners(p))} />;
              case "drawingImage":
                return (
                  <polygon
                    key={key}
                    points={pts([p.min, { x: p.max.x, y: p.min.y }, p.max, { x: p.min.x, y: p.max.y }])}
                  />
                );
              default:
                return null;
            }
          })}
        </g>
      )}
      {/* Auswahl-Rechteck (Marquee). Gestrichelt; die crossing-Variante (rechts→
          links, berührend) hebt sich farblich/strichlich ab. Das Rechteck steht
          bereits in viewBox-Einheiten → direkt setzbar. */}
      {marqueeRect && (
        <rect
          className={
            marqueeRect.crossing
              ? "plan-marquee plan-marquee-crossing"
              : "plan-marquee"
          }
          x={marqueeRect.x - overlayOrigin.x}
          y={marqueeRect.y - overlayOrigin.y}
          width={marqueeRect.w}
          height={marqueeRect.h}
          style={{ stroke: marqueeColor, fill: marqueeColor }}
          pointerEvents="none"
        />
      )}
      {/* Bezier-Hilfslinien (Anker → Griff), gestrichelt — VOR den Griff-
          Quadraten gezeichnet, damit die Griffe oben liegen (anklickbar). */}
      {gripsActive &&
        gripHandleLines &&
        gripHandleLines.map((l, i) => (
          <line
            key={`gripline-${i}`}
            className="plan-grip-line"
            x1={toLocal(l.a).x}
            y1={toLocal(l.a).y}
            x2={toLocal(l.b).x}
            y2={toLocal(l.b).y}
            pointerEvents="none"
          />
        ))}
      {/* Editier-Griffe des selektierten Elements (Wand-Enden / 2D-Vertices):
          ziehbare Kreise. Bildschirmkonstante Größe über die meet-Skala.
          Radius bewusst kleiner als der Treffer-Radius (GRIP_HIT_PX) — die
          Klickfläche bleibt grosszügig, nur die sichtbare Form schrumpft. */}
      {gripsActive && (
        <LiveMeet store={meetStore} base={meetScale(view, canvasRef.current ?? svgRef.current) ?? 1}>
          {(meet) =>
            // Viele Griffe (Kataster): nur die sichtbaren zeichnen (gripCull.ts).
            (visibleGripIndices(grips!, toScreen, view, meet) ?? grips!.map((_, i) => i)).map((i) => {
              const s = toLocal(grips![i]);
              const size = (4.5 * gripK(meet)) / meet;
              // Einfüge-Griff (Mitte eines Schnitt-Segments): kleine Raute, eigene Optik gegenüber den Eck-Griffen.
              if ((grips![i] as { insert?: boolean }).insert) {
                const d = size * 0.9;
                return (
                  <polygon
                    key={`grip-${i}`}
                    className="plan-grip plan-grip-insert"
                    points={`${s.x},${s.y - d} ${s.x + d},${s.y} ${s.x},${s.y + d} ${s.x - d},${s.y}`}
                    pointerEvents="none"
                  />
                );
              }
              return (
                <circle
                  key={`grip-${i}`}
                  className="plan-grip"
                  cx={s.x}
                  cy={s.y}
                  r={size}
                  pointerEvents="none"
                />
              );
            })
          }
        </LiveMeet>
      )}
      {/* Raum-Stempel-Griff: eine ziehbare Raute am Anker des gewählten Raums.
          Verschiebt NUR den Stempel (nicht die Kontur); Doppelklick öffnet den
          Editor. Bildschirmkonstante Größe. */}
      {stampAt && (
        <LiveMeet store={meetStore} base={meetScale(view, canvasRef.current ?? svgRef.current) ?? 1}>{(meet) => {
          const s = toLocal(stampAt);
          const size = 4 / meet;
          const pts = [
            `${s.x},${s.y - size}`,
            `${s.x + size},${s.y}`,
            `${s.x},${s.y + size}`,
            `${s.x - size},${s.y}`,
          ].join(" ");
          return (
            <polygon
              className="plan-grip plan-stamp-grip"
              points={pts}
              pointerEvents="none"
            />
          );
        }}</LiveMeet>
      )}
      {/* Kanten-/Seiten-Griffe: je Seite ein dreieckiger Anfasser, leicht nach
          AUSSEN entlang der (bildschirm-transformierten) Normale versetzt, mit
          der Spitze nach außen. Y wird gespiegelt (toScreen spiegelt Y), damit
          das Dreieck wirklich nach außen zeigt. Größe bildschirmkonstant. */}
      {edgeGripsActive && (
        <LiveMeet store={meetStore} base={meetScale(view, canvasRef.current ?? svgRef.current) ?? 1}>
          {(s) =>
        (visibleGripIndices(edgeGrips!.map((g) => g.mid), toScreen, view, s) ?? edgeGrips!.map((_, i) => i)).map((i) => {
          const eg = edgeGrips![i];
          const m = toLocal(eg.mid);
          // Normale in den Bildschirmraum (Y spiegeln); auf Bildschirm-px-Größen.
          const sn = screenNormal(eg.normal);
          const hVb = (EDGE_GRIP_H_PX * gripK(s)) / s; // Dreieckshöhe (nach außen)
          const halfVb = (EDGE_GRIP_HALF_PX * gripK(s)) / s; // halbe Basisbreite
          // Tangente = 90°-Drehung der (Bildschirm-)Normale, für die Basisbreite.
          const tx = -sn.y;
          const ty = sn.x;
          // Basis SITZT AUF DER LINIE (Mittelpunkt m), Spitze zeigt nach außen.
          const tipX = m.x + sn.x * hVb;
          const tipY = m.y + sn.y * hVb;
          const b1x = m.x + tx * halfVb;
          const b1y = m.y + ty * halfVb;
          const b2x = m.x - tx * halfVb;
          const b2y = m.y - ty * halfVb;
          return (
            <polygon
              key={`edge-grip-${i}`}
              className="plan-edge-grip"
              points={`${tipX},${tipY} ${b1x},${b1y} ${b2x},${b2y}`}
              pointerEvents="none"
            />
          );
        })
          }
        </LiveMeet>
      )}
      {/* Werkzeug-Overlay: Live-Vorschau (Rubber-Band) + gesetzte Stützpunkte +
          Snap-Marker + HUD. Immer obenauf, pointerEvents none. Glyph-/Schrift-
          Größen werden über die aktuelle meet-Skala bildschirmkonstant gehalten. */}
      {toolHandlers?.draft && (
        <LiveMeet store={meetStore} base={meetScale(view, canvasRef.current ?? svgRef.current) ?? 1}>
          {(meet) => (
            <DraftOverlay
              draft={toolHandlers.draft!}
              toScreen={toLocal}
              vbPerPx={1 / meet}
              snapColor={snapColor}
              hudFields={hudFields ?? null}
              units={units}
            />
          )}
        </LiveMeet>
      )}
      {/* Hover-Teilpunkte (s. hoverDivideSeg oben): kleine Punkte in Akzentfarbe
          an den `hoverDivideCount`-gleichen Teilpunkten des gehoverten Segments
          (2 = nur Mitte). Nur im Ruhezustand (kein Werkzeug aktiv). */}
      {hoverDivideSeg && !toolActive && (<LiveMeet store={meetStore} base={meetScale(view, canvasRef.current ?? svgRef.current) ?? 1}>{(meet) => {
        const vbPerPx = 1 / meet;
        const r = 3.5 * vbPerPx;
        const n = Math.max(2, Math.round(hoverDivideCount));
        const { a, b } = hoverDivideSeg;
        const pts = Array.from({ length: n - 1 }, (_, i) => {
          const t = (i + 1) / n;
          return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        });
        return (
          <g className="plan-hover-divide" pointerEvents="none">
            {pts.map((pt, i) => {
              const s = toLocal(pt);
              return (
                <circle
                  key={i}
                  cx={s.x}
                  cy={s.y}
                  r={r}
                  style={{ fill: snapColor, stroke: snapColor }}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </g>
        );
      }}</LiveMeet>)}
      </svg>
      {/* Inline-Text-Editor DIREKT auf der Zeichenfläche (kein Dialog, Nutzer-
          Feedback) — für ein frisch über `text`/`textbox` erzeugtes Element
          (sofort nach dem Platzieren, s. App.tsx host.focusDrawing) ODER ein
          per Doppelklick geöffnetes bestehendes. `RichTextEditor` bringt seine
          eigene Mini-Toolbar mit; die schwebt PER CSS (s. styles.css
          `.planview-inline-text .rt-toolbar`, `position:absolute;
          bottom:100%`) OBERHALB der Textfläche, ausserhalb von deren
          Layout-Fluss — sie darf die Fläche NICHT nach unten schieben
          (Bug-Meldung "Editor ist tiefer als der Text": vorher stand die
          Toolbar noch im normalen Fluss ÜBER der Fläche und schob sie um
          ihre eigene, zoomunabhängige Höhe nach unten, während hier nur mit
          EINER Zeilenhöhe Versatz gerechnet wird — bei üblichem Zoom kleiner
          als die Toolbar-Höhe). `at` ist die Baseline-links der ersten Zeile
          (s. primitives.tsx "drawingText") — der Editor-Rahmen (= die
          Textfläche, jetzt ohne die Toolbar davor) sitzt daher ~eine
          Zeilenhöhe darüber. OHNE `wrapWidth` (Text-Werkzeug) bleibt die
          Breite frei (kein Wortumbruch, nur Enter erzeugt neue Zeilen); MIT
          `wrapWidth` (Textspalte) bricht der Editor live um wie ein
          InDesign-Textrahmen — `position:"fixed"` mit echten Client-Pixeln
          (vbToClient), damit die Positionierung unabhängig vom umgebenden
          Layout stimmt. */}
      {editTextId &&
        (() => {
          const prim = planTextEntries(plan)
            .map((e) => e.p)
            .find((p): p is Extract<Primitive, { kind: "drawingText" }> => p.kind === "drawingText" && p.drawingId === editTextId);
          if (!prim) return null;
          const doc = prim.doc ?? docFromText(prim.text, prim.marks ?? {});
          // WYSIWYG: Position, Breite, Feldhöhe UND Schriftgrösse folgen alle dem
          // echten Zoom (currentPxPerMeter) — die Box soll exakt so aussehen wie
          // der spätere gerenderte Text, in genau der Grösse des gezeichneten
          // Feldes (Nutzer-Wunsch). Die Schriftgrösse geht NICHT über
          // transform:scale() auf die ganze Box (das skalierte vorher die
          // Toolbar mit hoch und sprengte sie beim Reinzoomen), sondern NUR auf
          // die Textfläche via CSS-Variable (--rt-font-size/--rt-min-height,
          // s. styles.css `.planview-inline-text .rt-surface`) — die Toolbar
          // bleibt dadurch immer normal gross und bedienbar.
          const pxPerM = currentPxPerMeter();
          // Baseline → Box-Oberkante: ECHTES Font-Measuring statt der groben
          // "ganzes heightM = Ascent"-Näherung (Bug-Meldung "Sprung nach
          // rechts oben" — Rest-Y-Versatz nach dem Toolbar-Fluss-/Schrift-Fix).
          const baselineFromTop = contentFontBaselineFromTop(TEXT_LINE_HEIGHT_MULT);
          const topAnchor = toScreen({ x: prim.at.x, y: prim.at.y + prim.heightM * baselineFromTop });
          const screen = vbToClient(topAnchor.x, topAnchor.y);
          const hasWrap = !!prim.wrapWidth;
          const widthPx = hasWrap ? prim.wrapWidth! * pxPerM : undefined;
          const minWidthPx = hasWrap ? undefined : 160;
          const fontSizePx = Math.max(9, prim.heightM * pxPerM);
          // Aufgezogener Textspalten-Rahmen (textbox.ts): dessen Höhe als
          // Mindesthöhe der Textfläche — wächst bei mehr Text darüber hinaus.
          const minHeightPx = editTextMinHeightM ? editTextMinHeightM * pxPerM : undefined;
          const cssVars = {
            "--rt-font-size": `${fontSizePx}px`,
            ...(minHeightPx ? { "--rt-min-height": `${minHeightPx}px` } : {}),
          } as CSSProperties;
          return (
            <>
              <div
                className="planview-inline-backdrop"
                onPointerDown={() => onCloseTextEdit?.()}
              />
              <div
                className={"planview-inline-text" + (hasWrap ? "" : " planview-inline-text-free")}
                style={{
                  left: screen.x,
                  top: screen.y,
                  width: widthPx,
                  minWidth: minWidthPx,
                  ...cssVars,
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    onCloseTextEdit?.();
                  }
                }}
              >
                <RichTextEditor
                  value={doc}
                  onChange={(d) => onCommitTextEdit?.(d)}
                  autoFocus
                  sizeUnit="em"
                />
              </div>
            </>
          );
        })()}
      {/* Lineale (oben + links, VW-Stil): Modell-Meter mit Ticks, Beschriftung
          und Cursor-Marker — screen-fix über den sichtbaren Ausschnitt gelegt.
          BEWUSST ein eigenes Sibling-SVG (nicht mehr Kind von `svgRef`): beim
          imperativen GL-Pan (`applySvgTransform`, s.o.) bekommt NUR `svgRef`
          während der Geste einen CSS-transform verpasst — läge das Lineal
          darin, würde es sichtbar mit dem Inhalt mitwandern statt am Rand
          fixiert zu bleiben. Als eigenständiges Element bleibt es während der
          Geste stehen (aktualisiert erst beim Loslassen, wenn `view` neu
          gesetzt wird) — exakt das gewünschte „statische" Verhalten. */}
      {showRulers && (<LiveValue store={viewStore} base={view}>{(liveView) => {
        const view = liveView;
        const m = measure(view);
        if (!m.rect) return null;
        const scale = m.scale || 1;
        const vb = {
          x0: view.x - m.offX / scale,
          y0: view.y - m.offY / scale,
          w: (m.rect.width || 1) / scale,
          h: (m.rect.height || 1) / scale,
        };
        return (
          <svg
            className="plan-ruler-overlay"
            viewBox={`${vb.x0 - overlayOrigin.x} ${vb.y0 - overlayOrigin.y} ${vb.w} ${vb.h}`}
            preserveAspectRatio="none"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              zIndex: 2,
              pointerEvents: "none",
            }}
          >
            <LiveRulers
              vb={vb}
              origin={overlayOrigin}
              vbPerPx={1 / scale}
              pxPerMeter={scale * PX_PER_M}
              store={rulerCursor}
              units={units}
            />
          </svg>
        );
      }}</LiveValue>)}
      {pickList && (
        <div
          className="pick-list"
          role="listbox"
          aria-label={t("pick.list.title")}
          style={{ left: pickList.x, top: pickList.y }}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => ev.stopPropagation()}
        >
          <div className="pick-list-head">
            {t("pick.list.title", { n: pickList.items.length })}
          </div>
          {pickList.items.map((c, i) => (
            <button
              key={`${c.kind}:${c.id}`}
              type="button"
              role="option"
              aria-selected={i === pickList.idx}
              className={`pick-list-item${i === pickList.idx ? " is-current" : ""}`}
              onMouseEnter={() => setHoverPick(c)}
              onMouseLeave={() => setHoverPick(null)}
              onFocus={() => setHoverPick(c)}
              onBlur={() => setHoverPick(null)}
              onClick={(ev) => {
                const cur = cycleRef.current;
                if (cur) cur.idx = i;
                // Shift (oder Liste per Cmd+Shift geöffnet): Eintrag zur bestehenden Auswahl
                // dazuwählen; der beim Öffnen schon dazugewählte Zwischenstand wird ersetzt.
                const additive = ev.shiftKey || !!cur?.additive;
                const prevApplied = cur?.applied;
                if (additive && prevApplied?.id === c.id && prevApplied.kind === c.kind) {
                  setPickList({ ...pickList, idx: i }); // schon dazugewählt: nicht wieder abschalten
                  return;
                }
                const replaces =
                  additive && prevApplied && prevApplied.id !== c.id
                    ? { kind: prevApplied.kind, id: prevApplied.id }
                    : undefined;
                if (cur) cur.applied = additive ? c : undefined;
                applyCandidate(c, cur?.model ?? { x: 0, y: 0 }, additive, replaces);
                setPickList({ ...pickList, idx: i });
              }}
            >
              {c.label}
            </button>
          ))}
          <div className="pick-list-hint">{t(IS_MAC ? "pick.list.hint.mac" : "pick.list.hint.other")}</div>
        </div>
      )}
    </div>
  );
});
