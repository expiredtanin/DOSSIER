// Treffer-Abfragen der Plan-Ansicht ([165] aus `PlanView.tsx`): welches Bauteil, 2D-Element, Lage-Objekt
// oder welcher Baum liegt unter dem Cursor (über den Pick-Index im Kern), dazu die Hover-Teilpunkte,
// der gegriffene Körper und die Marquee-Treffer. Aufgerufen einmal von `PlanView`.

import type { GroupableHit, BodyTarget } from "./types";
import { planPrimAt, nearestInDrawings, marqueeHitUnderlay } from "../../../core";
import { LINE_PICK_PX, TREE_PICK } from "./constants";
import type { Primitive, ModelRect } from "../../../core";
import type { Vec2 } from "../../../model/types";
import { useState, useRef, useEffect } from "react";
import type { ViewBox__plan_planView_geometry as ViewBox } from "../../../core";
import { PlanPickIndex } from "../../../core";
import type { Plan } from "../../../core";
import type { DrawingIndex } from "../../../core";
import type { ClientMap } from "../../../core";
import type { UnderlayGroup } from "../../../core";
import type { Drawing2D } from "../../../model/types";

/** Werte aus `PlanView`, die dieser Hook liest (unverändert, ohne Kopie). */
export interface UsePlanPickingArgs {
  clientToView: (clientX: number, clientY: number, vb: ViewBox) => Vec2;
  view: ViewBox;
  getPick: () => PlanPickIndex;
  viewToModel: (vbX: number, vbY: number) => Vec2;
  plan: Plan;
  currentPxPerMeter: () => number;
  rawModelAt: (clientX: number, clientY: number) => Vec2;
  getUnderlayIndex: () => DrawingIndex | null;
  clientMap: () => ClientMap;
  hoverDivideDelayMs: number;
  toolActive: boolean;
  sheetBodies: boolean;
  selectedOpeningIds: string[];
  selectedCeilingIds: string[];
  selectedStairIds: string[];
  selectedWallIds: string[];
  selectedDrawingIds: string[];
  selectedDrawingId: string | null;
  getUnderlayIds: () => Map<string, UnderlayGroup> | null;
  getUnderlay: () => { key: UnderlayGroup[]; drawings: Drawing2D[]; index?: DrawingIndex | null; ids?: Map<string, UnderlayGroup>; } | null;
}

export function usePlanPicking(inp: UsePlanPickingArgs) {
  const {
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
  } = inp;

  // Trefferprüfung: liefert den Index des obersten Polygon-Primitivs unter dem
  // Cursor (Modellpunkt in einem Schicht-Polygon) oder null. In umgekehrter
  // Reihenfolge testen, damit das zuletzt gezeichnete (oberste) zuerst trifft.
  // [137] Übersprungen werden Flächen ohne Bauteil: Darstellung ohne Id (Schlagschatten der Ansicht,
  // Baurechts-Verstösse, Muster) und unsichtbare Pick-Bänder (Gelände-Rahmen, Baugrube, Schatten, Schnittlinie)
  // — sie lagen sonst über Wänden und Decken und machten diese unwählbar. Eine sichtbare Kontext-Fläche
  // (Gelände in der Ansicht) verdeckt dagegen wie bisher.
  const hitTest = (clientX: number, clientY: number): number | null => {
    const v = clientToView(clientX, clientY, view);
    // Unter einem Gelände-/Baugruben-Band zählt die leere Innenfläche einer 2D-Kontur (z. B. Parzelle) nicht:
    // dort meint der Klick das Gelände (die Kontur bleibt über ihre Linie wählbar) — wie vor [137].
    const pick = getPick();
    let underBand = false;
    for (const i of pick.polygonsAt(viewToModel(v.x, v.y))) {
      const p = pick.prim(i);
      if (p?.kind !== "polygon") continue;
      if (p.wallId || p.drawingId || p.ceilingId || p.openingId || p.stairId || p.roomId || p.extrudedSolidId || p.columnId || p.roofId) {
        const emptyArea = p.drawingId && p.fill === "none" && (!p.hatch || p.hatch.pattern === "none");
        return underBand && emptyArea ? null : i;
      }
      // Lage-Darstellung (`@…`: Schlagschatten der Ansicht, Schatten, Baurecht) verdeckt nie — sie liegt auf den
      // Bauteilen und wird erst nach ihnen gewählt (bzw. per erneutem Klick, [137] Klick-Zyklus).
      if (((p.contextObjectId && !p.contextObjectId.startsWith("@")) || p.sectionLineId) && p.fill !== "none") return i;
      if (p.contextObjectId && !p.contextObjectId.startsWith("@")) underBand = true;
    }
    return null;
  };

  // Irgendein Element (Wand/Decke/Raum/Treppe/Stütze/Dach/2D) unter dem
  // Cursor — für Gruppen-Eintritt per Doppelklick (`onEnterGroup`). Nutzt
  // `hitTest` (Polygon-Primitive, deckt alle flächigen Bauteile ab) und
  // fällt für linienbasierte 2D-Elemente auf `pickDrawing` zurück (das
  // selbst erst nach dessen Definition unten verfügbar ist, daher als
  // separate Closure statt inline hier).
  const anyGroupableHit = (clientX: number, clientY: number): GroupableHit | null => {
    const idx = hitTest(clientX, clientY);
    if (idx !== null) {
      const p = planPrimAt(plan, idx);
      if (p?.kind === "polygon") {
        if (p.wallId) return { wallId: p.wallId };
        if (p.ceilingId) return { ceilingId: p.ceilingId };
        if (p.roomId) return { roomId: p.roomId };
        if (p.stairId) return { stairId: p.stairId };
        if (p.columnId) return { columnId: p.columnId };
        if (p.roofId) return { roofId: p.roofId };
        if (p.drawingId) return { drawingId: p.drawingId };
      }
    }
    const did = pickDrawing(clientX, clientY);
    return did ? { drawingId: did } : null;
  };

  // Nächstgelegenes 2D-Zeichenelement (Drawing2D) zum Cursor per Linien-Nähe in
  // Bildschirm-Pixeln (zoom-unabhängige Toleranz). Liefert die drawingId oder null.
  const pickDrawing = (clientX: number, clientY: number): string | null => {
    let bestId: string | null = null;
    let bestDist = LINE_PICK_PX;
    const pick = getPick();
    const pxPerM = currentPxPerMeter();
    const m = rawModelAt(clientX, clientY);
    const seg = pick.nearestSegment(m, LINE_PICK_PX / pxPerM);
    if (seg) {
      bestId = (planPrimAt(plan, seg.i) as Extract<Primitive, { kind: "line" }>).drawingId!;
      bestDist = seg.dist * pxPerM;
    }
    const uIndex = getUnderlayIndex();
    if (uIndex) {
      const hit = nearestInDrawings(uIndex, m, bestDist / pxPerM);
      if (hit) {
        bestId = hit.drawing.id;
        bestDist = hit.dist * pxPerM;
      }
    }
    // Kreise/Bögen (Ring-Abstand wie früher `distToDrawingRing`), in Plan-Reihenfolge.
    for (const { i, dpx } of pick.ringsNear(m, pxPerM, LINE_PICK_PX)) {
      if (dpx < bestDist) {
        bestDist = dpx;
        bestId = (planPrimAt(plan, i) as Extract<Primitive, { kind: "drawingCircle" | "drawingArc" }>).drawingId!;
      }
    }
    if (bestId) return bestId;
    // Kein Linien-/Kreis-/Bogen-Treffer: Text- dann Bild-Elemente prüfen (eigene Bbox-Logik).
    return pickDrawingText(clientX, clientY) ?? pickDrawingImage(clientX, clientY);
  };

  // Nächstgelegenes EINZELNES Geraden-Segment (nicht das ganze Element) für
  // die Hover-Teilpunkte-Anzeige (s. hoverDivideSeg unten) — dieselbe Nähe-
  // Logik wie pickDrawing, liefert aber die zwei Endpunkte des getroffenen
  // Segments selbst: eine Polylinie besteht aus mehreren "line"-Primitiven
  // (eins je Segment, gleiche drawingId), unterteilt werden soll nur das
  // konkret gehoverte Segment, nicht das ganze Element.
  const nearestLineSegment = (clientX: number, clientY: number): { a: Vec2; b: Vec2 } | null => {
    const m = rawModelAt(clientX, clientY);
    const maxDist = LINE_PICK_PX / currentPxPerMeter();
    let best: { a: Vec2; b: Vec2 } | null = null;
    let bestDist = maxDist;
    const seg = getPick().nearestSegment(m, maxDist);
    if (seg) {
      const p = planPrimAt(plan, seg.i) as Extract<Primitive, { kind: "line" }>;
      best = { a: p.a, b: p.b };
      bestDist = seg.dist;
    }
    const uIndex = getUnderlayIndex();
    if (uIndex) {
      const hit = nearestInDrawings(uIndex, m, bestDist);
      if (hit) best = { a: hit.a, b: hit.b };
    }
    return best;
  };

  // Trifft der Klick ein Text-2D-Element (kind "drawingText")? Grosszügige Modell-
  // Bounding-Box um den Ankerpunkt (Text hat keine Linien-Geometrie zum Anfassen; Winkel
  // vernachlässigt) — im Kern (`plan_pick.rs`). Liefert die drawingId oder null.
  const pickDrawingText = (clientX: number, clientY: number): string | null => {
    const pick = getPick();
    const i = pick.drawingTextAt(rawModelAt(clientX, clientY));
    return i === null ? null : ((pick.prim(i) as { drawingId?: string }).drawingId ?? null);
  };

  // Trifft der Klick ein Bild-2D-Element (kind "drawingImage")? Reine Bounding-Box-Prüfung
  // (achsparallel, oberstes zuerst). Liefert die drawingId oder null.
  const pickDrawingImage = (clientX: number, clientY: number): string | null => {
    const pick = getPick();
    const i = pick.drawingImageAt(rawModelAt(clientX, clientY));
    return i === null ? null : ((pick.prim(i) as { drawingId?: string }).drawingId ?? null);
  };

  // Nächstgelegene Öffnung (Fenster/Tür) zum Cursor: Linien-/Bogen-Primitive mit
  // `openingId` per Bildschirm-Nähe, plus getroffene Fenster-Rahmen (Polygon mit
  // openingId, per Punkt-in-Polygon). Liefert die openingId oder null.
  const pickOpening = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    const pick = getPick();
    // Getroffener Rahmen (das zuerst gezeichnete Polygon) hat Vorrang vor Symbol-Linien.
    const hit = pick.bottomPolygon(m, "openingId");
    if (hit !== null) return (planPrimAt(plan, hit) as { openingId?: string }).openingId!;
    const i = pick.nearestSymbolPx(["openingId"], ["openingId"], clientMap(), { x: clientX, y: clientY }, LINE_PICK_PX);
    return i === null ? null : (planPrimAt(plan, i) as { openingId?: string }).openingId!;
  };

  // Nächstgelegene Treppe zum Cursor: getroffenes Tritt-/Podest-Polygon (per
  // Punkt-in-Polygon), sonst eine nahe Symbollinie (Lauflinie/Pfeil) mit stairId.
  const pickStair = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    const pick = getPick();
    const hit = pick.bottomPolygon(m, "stairId");
    if (hit !== null) return (planPrimAt(plan, hit) as { stairId?: string }).stairId!;
    const i = pick.nearestSymbolPx(["stairId"], [], clientMap(), { x: clientX, y: clientY }, LINE_PICK_PX);
    return i === null ? null : (planPrimAt(plan, i) as { stairId?: string }).stairId!;
  };

  // Getroffener Raum: die Raum-Fläche (Polygon mit `roomId`) per Punkt-in-Polygon.
  // Bei überlappenden Räumen gewinnt der zuletzt gezeichnete (oberste).
  const pickRoom = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const i = getPick().topPolygon(viewToModel(v.x, v.y), "roomId");
    return i === null ? null : (planPrimAt(plan, i) as { roomId?: string }).roomId!;
  };

  // Getroffenes Dach: das unsichtbare Traufe-Pick-Polygon per Punkt-in-Polygon
  // (die sichtbaren Dachlinien allein wären schwer exakt zu treffen).
  const pickRoof = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const i = getPick().topPolygon(viewToModel(v.x, v.y), "roofId");
    return i === null ? null : (planPrimAt(plan, i) as { roofId?: string }).roofId!;
  };

  // Getroffene Schnitt-/Ansichtslinie: ihr schmales, unsichtbares Pick-Band
  // (Polygon mit sectionLineId) per Punkt-in-Polygon.
  const pickSectionLine = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const i = getPick().topPolygon(viewToModel(v.x, v.y), "sectionLineId");
    return i === null ? null : (planPrimAt(plan, i) as { sectionLineId?: string }).sectionLineId!;
  };

  // Getroffenes Kontext-Objekt (importiertes Gebäude/Terrain): sein unsichtbares
  // Grundriss-Pick-Band (Bounding-Box) per Punkt-in-Polygon — macht es wie eine
  // Wand irgendwo innerhalb seiner Fläche anklickbar, nicht nur exakt auf der
  // dünnen Umrisslinie.
  // Pick-Ids unter dem Cursor im Feld `contextObjectId`, oberste zuerst. Die abgeleitete Lage-Darstellung
  // ([137], Kern `plan/extras.rs`) trägt dort `@sunStudy`/`@siteRules` (Schattenflächen, Baurechts-Bänder).
  const contextIdsAt = (clientX: number, clientY: number): string[] => {
    const v = clientToView(clientX, clientY, view);
    const pick = getPick();
    return pick.polygonsAt(viewToModel(v.x, v.y), "contextObjectId").map((i) => (pick.prim(i) as { contextObjectId?: string }).contextObjectId!);
  };

  // [137] Getroffene Lage-Darstellung: Quelle `"sunStudy"`/`"siteRules"` (Baurechtslinie vor Schatten) oder null.
  const pickSiteAt = (clientX: number, clientY: number): string | null => {
    const ids = contextIdsAt(clientX, clientY).filter((id) => id.startsWith("@") && !id.startsWith(TREE_PICK));
    const id = ids.find((x) => x === "@siteRules") ?? ids[0];
    return id ? id.slice(1) : null;
  };

  // [149] Getroffener Baum (oberste Kronenfläche) oder null.
  const pickTree = (clientX: number, clientY: number): string | null => {
    const id = contextIdsAt(clientX, clientY).find((x) => x.startsWith(TREE_PICK));
    return id ? id.slice(TREE_PICK.length) : null;
  };

  const pickContextObject = (clientX: number, clientY: number): string | null =>
    contextIdsAt(clientX, clientY).find((id) => !id.startsWith("@")) ?? null;

  // Getroffener extrudierter Körper (truck-Integration): der Footprint-Umriss
  // ist ein reiner Haarlinien-Umriss (fill:"none"), aber per Punkt-in-Polygon
  // trotzdem als FLÄCHE anklickbar (analog Raum, nicht nur auf der Linie).
  const pickExtrudedSolid = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const i = getPick().topPolygon(viewToModel(v.x, v.y), "extrudedSolidId");
    return i === null ? null : (planPrimAt(plan, i) as { extrudedSolidId?: string }).extrudedSolidId!;
  };

  // Getroffene Stütze (Tragwerk): ihr Querschnitt ist eine gefüllte Poché
  // (Polygon mit columnId) — per Punkt-in-Polygon als FLÄCHE anklickbar.
  const pickColumn = (clientX: number, clientY: number): string | null => {
    const v = clientToView(clientX, clientY, view);
    const i = getPick().topPolygon(viewToModel(v.x, v.y), "columnId");
    return i === null ? null : (planPrimAt(plan, i) as { columnId?: string }).columnId!;
  };

  // Hover-Teilpunkte (Nutzer-Wunsch): ruht der Cursor im Auswahl-Ruhezustand
  // (kein Werkzeug/Drag/Marquee — s. Aufruf in onPointerMove) länger als
  // `hoverDivideDelayMs` auf einem 2D-Linien-Segment, werden dessen gleiche
  // Teilpunkte (Anzahl `hoverDivideCount`, 2 = nur Mitte) kurz mit
  // Akzentfarbe eingeblendet. Reine Sichtbarkeits-Hilfe, kein Snap-Ziel.
  const [hoverDivideSeg, setHoverDivideSeg] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  // Zuletzt erkanntes Segment (Serialisiert als Schlüssel) — erkennt einen
  // Wechsel, ohne bei jedem Move-Event neu zu timern.
  const hoverDivideKeyRef = useRef<string | null>(null);
  const hoverDivideTimerRef = useRef<number | null>(null);

  // Nächstliegendes Linien-Segment unterm Cursor ermitteln und die
  // Hover-Teilpunkte-Anzeige entsprechend (neu) timern/verwerfen.
  const updateHoverDivide = (clientX: number, clientY: number) => {
    const seg = nearestLineSegment(clientX, clientY);
    const key = seg ? `${seg.a.x},${seg.a.y}|${seg.b.x},${seg.b.y}` : null;
    if (key === hoverDivideKeyRef.current) return; // dasselbe Segment (oder weiter keins)
    hoverDivideKeyRef.current = key;
    if (hoverDivideTimerRef.current !== null) {
      window.clearTimeout(hoverDivideTimerRef.current);
      hoverDivideTimerRef.current = null;
    }
    setHoverDivideSeg(null); // Segment gewechselt → alte Anzeige sofort weg
    if (!seg) return;
    hoverDivideTimerRef.current = window.setTimeout(() => {
      hoverDivideTimerRef.current = null;
      setHoverDivideSeg(seg);
    }, hoverDivideDelayMs);
  };
  const clearHoverDivide = () => {
    if (hoverDivideTimerRef.current !== null) {
      window.clearTimeout(hoverDivideTimerRef.current);
      hoverDivideTimerRef.current = null;
    }
    hoverDivideKeyRef.current = null;
    setHoverDivideSeg(null);
  };
  // Weg, sobald ein Werkzeug aktiv wird (sonst könnte eine veraltete Anzeige
  // ohne weiteres Move-Event über einem neuen Werkzeug-Entwurf stehen bleiben).
  useEffect(() => {
    if (toolActive) clearHoverDivide();
  }, [toolActive]);
  useEffect(() => () => clearHoverDivide(), []);

  // Liegt der Cursor auf dem KÖRPER eines GEWÄHLTEN Elements (Wand-Poché bzw.
  // 2D-Linie)? Liefert das gegriffene Element (Wand-ID ODER Drawing-ID) für das
  // Parallel-Verschieben — oder null. Bei MEHRFACHAUSWAHL wird das Element UNTER
  // dem Cursor gegriffen; die übrigen gewählten Enden wandern (App) koinzident mit.
  const grabbedBody = (
    clientX: number,
    clientY: number,
  ): BodyTarget | null => {
    // Schnitt/Ansicht: gewählte Öffnung bzw. Decke unter dem Cursor (Vorrang vor
    // der Wirtswand, die im Blatt dahinter liegt).
    if (sheetBodies) {
      const hi = hitTest(clientX, clientY);
      const p = hi !== null ? planPrimAt(plan, hi) ?? null : null;
      if (p && "openingId" in p && p.openingId && selectedOpeningIds?.includes(p.openingId)) {
        return { openingId: p.openingId };
      }
      if (p && p.kind === "polygon" && p.ceilingId && selectedCeilingIds?.includes(p.ceilingId)) {
        return { ceilingId: p.ceilingId };
      }
      if (p && p.kind === "polygon" && p.stairId && selectedStairIds?.includes(p.stairId)) {
        return { stairId: p.stairId };
      }
    }
    const selWalls = new Set(selectedWallIds ?? []);
    if (selWalls.size) {
      const hi = hitTest(clientX, clientY);
      if (hi !== null) {
        const p = planPrimAt(plan, hi);
        if (p?.kind === "polygon" && p.wallId && selWalls.has(p.wallId)) {
          return { wallId: p.wallId };
        }
      }
    }
    const selDraws = selectedDrawingIds && selectedDrawingIds.length
      ? new Set(selectedDrawingIds)
      : selectedDrawingId
        ? new Set([selectedDrawingId])
        : null;
    if (selDraws) {
      const id = pickDrawing(clientX, clientY);
      if (id && selDraws.has(id)) return { drawingId: id };
    }
    return null;
  };

  // Marquee über Zeichnungen: Primitive (ohne die der kompakten Unterlage, deren
  // Polygon-Punkte allein sonst ein anderes Ergebnis lieferten) + Unterlage.
  const marqueeHitAll = (rect: ModelRect, crossing: boolean): string[] => {
    const ids = getUnderlayIds();
    const fromPrims = getPick().marqueeDrawings(rect, crossing, ids?.keys());
    const u = getUnderlay();
    return u ? [...fromPrims, ...marqueeHitUnderlay(u.drawings, rect, crossing)] : fromPrims;
  };

  return {
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
  };
}
