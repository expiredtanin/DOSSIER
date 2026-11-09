// Durchschalten übereinanderliegender Objekte in der Plan-Ansicht ([165] aus `PlanView.tsx`): Auswahlliste,
// Klick-Zyklen (Cmd/Strg+Klick, einfacher Klick) und `endDrag` (Pointer-Up: Auswahl, Marquee, Drag-Ende).
// Aufgerufen einmal von `PlanView`.

import type { Selection } from "../../../state/selection";
import { useState, useEffect, useRef } from "react";
import type { PickCandidate, PickIds } from "./types";
import type { Plan, Primitive, PickKind } from "../../../core";
import type { Vec2 } from "../../../model/types";
import type { PlainCycle } from "../pickCycle";
import { selectionHas, plainCycleNext, cycleHint } from "../pickCycle";
import { t } from "../../../i18n";
import { LINE_PICK_PX, TREE_PICK, PICK_ORDER, EMPTY_PICK, MARQUEE_THRESHOLD_PX, cycleModifier } from "./constants";
import { planPrimAt, drawingsWithinDistance } from "../../../core";
import type { ViewBox__plan_planView_geometry as ViewBox } from "../../../core";
import { PlanPickIndex } from "../../../core";
import type { UnderlayGroup } from "../../../core";
import type { DrawingIndex } from "../../../core";
import type { PlanSelection } from "./types";
import type { EdgeGrip } from "../../../model/types";
import type { GripHandlers } from "./types";
import type { BodyTarget } from "./types";
import type { ToolHandlers } from "../../../tools/types";
import type { MarqueeSelection } from "./types";
import type { ModelRect } from "../../../core";

/** Werte aus `PlanView`, die dieser Hook liest (unverändert, ohne Kopie). */
export interface UsePlanPickCycleArgs {
  selection: Selection;
  onPickHint: ((hint: string | null) => void) | undefined;
  view: ViewBox;
  planRaw: Plan;
  resetKey: string | undefined;
  getPick: () => PlanPickIndex;
  rawModelAt: (clientX: number, clientY: number) => Vec2;
  getUnderlayIds: () => Map<string, UnderlayGroup> | null;
  currentPxPerMeter: () => number;
  plan: Plan;
  getUnderlayIndex: () => DrawingIndex | null;
  pickDrawingText: (clientX: number, clientY: number) => string | null;
  pickDrawingImage: (clientX: number, clientY: number) => string | null;
  describePick: ((kind: PickKind, id: string) => string | undefined) | undefined;
  pickOpening: (clientX: number, clientY: number) => string | null;
  pickColumn: (clientX: number, clientY: number) => string | null;
  pickExtrudedSolid: (clientX: number, clientY: number) => string | null;
  pickStair: (clientX: number, clientY: number) => string | null;
  pickRoom: (clientX: number, clientY: number) => string | null;
  pickRoof: (clientX: number, clientY: number) => string | null;
  pickTree: (clientX: number, clientY: number) => string | null;
  pickSiteAt: (clientX: number, clientY: number) => string | null;
  pickContextObject: (clientX: number, clientY: number) => string | null;
  pickSectionLine: (clientX: number, clientY: number) => string | null;
  onSelect: ((selection: PlanSelection) => void) | undefined;
  setSelected: React.Dispatch<React.SetStateAction<number | null>>;
  defaultPick: (clientX: number, clientY: number) => PickIds;
  clientToView: (clientX: number, clientY: number, vb: ViewBox) => Vec2;
  viewToModel: (vbX: number, vbY: number) => Vec2;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  dragMoveRaf: React.MutableRefObject<number | null>;
  gripDrag: React.MutableRefObject<{ pointerId: number; index: number; origin: Vec2; startX?: number; startY?: number; } | null>;
  edgeDrag: React.MutableRefObject<{ pointerId: number; edge: EdgeGrip; startX?: number; startY?: number; } | null>;
  dragMovePending: React.MutableRefObject<{ cx: number; cy: number; shift: boolean; ctrl: boolean; alt: boolean; pointerId: number; } | null>;
  gripHandlers: GripHandlers | undefined;
  stampDrag: React.MutableRefObject<{ pointerId: number; roomId: string; last: Vec2; from: Vec2 | null; } | null>;
  moveDrag: React.MutableRefObject<{ pointerId: number; last: Vec2; startX?: number; startY?: number; target: BodyTarget; } | null>;
  flushDragMove: () => void;
  toolActive: boolean;
  toolHandlers: ToolHandlers | undefined;
  toolMods: (e: React.PointerEvent | React.MouseEvent) => { shift: boolean; ctrl: boolean; alt: boolean; };
  marquee: React.MutableRefObject<{ pointerId: number; startClientX: number; startClientY: number; startView: Vec2; moved: boolean; } | null>;
  onMarquee: ((selection: MarqueeSelection) => void) | undefined;
  marqueeHitAll: (rect: ModelRect, crossing: boolean) => string[];
  setMarqueeRect: React.Dispatch<React.SetStateAction<{ x: number; y: number; w: number; h: number; crossing: boolean; } | null>>;
  drag: React.MutableRefObject<{ pointerId: number; startClientX: number; startClientY: number; startView: ViewBox; } | null>;
  commitPan: () => void;
  setDragging: React.Dispatch<React.SetStateAction<boolean>>;
}

export function usePlanPickCycle(inp: UsePlanPickCycleArgs) {
  const {
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
  } = inp;

  // ── Übereinanderliegende Objekte durchschalten ────────────────────────────
  // Cmd+Klick (Mac) / Strg+Klick wählt das nächste Objekt UNTER dem Cursor;
  // wiederholtes Klicken an derselben Stelle läuft zyklisch durch alle. Eine
  // kleine Liste zeigt alle Objekte an der Stelle (direkt anklickbar). Der
  // normale Klick bleibt die bisherige Prioritätskette (`defaultPick`).
  const [pickList, setPickList] = useState<{ x: number; y: number; items: PickCandidate[]; idx: number } | null>(null);
  // Beim Überfahren eines Listeneintrags wird dieses Objekt im Plan hervorgehoben
  // (Vorschau, ohne zu wählen) — so erkennt man, welcher Eintrag welches Objekt ist.
  const [hoverPick, setHoverPick] = useState<PickCandidate | null>(null);
  useEffect(() => {
    if (!pickList) setHoverPick(null);
  }, [pickList]);
  const cycleRef = useRef<{
    x: number;
    y: number;
    plan: Plan;
    items: PickCandidate[];
    idx: number;
    model: Vec2;
    /** Zuletzt per Shift dazugewähltes Objekt (für Shift-Durchschalten). */
    applied?: PickCandidate;
    /** Liste per Cmd+Shift geöffnet → Klick auf einen Eintrag ERWEITERT die Auswahl. */
    additive?: boolean;
  } | null>(null);
  // Liste/Zyklus verwerfen, sobald sich Ausschnitt oder Plan ändern.
  // [137] Einfacher Klick-Zyklus: Kandidaten des letzten einfachen Klicks (s. pickCycle.ts).
  const plainCycleRef = useRef<PlainCycle<PickCandidate> | null>(null);
  const plainCyclePlan = useRef<Plan | null>(null);
  // Auswahl anderswo geändert (Escape, Panel): Zyklus und Hinweis verwerfen.
  useEffect(() => {
    const pc = plainCycleRef.current;
    if (pc && !selectionHas(selection, pc.items[pc.idx])) {
      plainCycleRef.current = null;
      onPickHint?.(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);
  useEffect(() => {
    setPickList(null);
    cycleRef.current = null;
  }, [view, planRaw]);
  // Der Klick-Zyklus überlebt neu erzeugte Pläne (Greifen des Gewählten baut den Plan neu auf): Kandidaten
  // sind Ids; nur Ausschnitt oder Ebene verwerfen ihn.
  useEffect(() => {
    plainCycleRef.current = null;
    onPickHint?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, resetKey]);
  useEffect(() => {
    if (!pickList) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setPickList(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickList]);

  /** Alle Polygone unter dem Cursor, oberstes zuerst. */
  const hitTestAll = (clientX: number, clientY: number): number[] => getPick().polygonsAt(rawModelAt(clientX, clientY));

  /** Bezeichnung eines 2D-Elements nach Form (Linie/Fläche/Text/Kreis/…). */
  const drawingLabel = (id: string): string => {
    const g = getUnderlayIds()?.get(id);
    const ud = g?.drawings.find((x) => x.id === id);
    if (ud) {
      return ud.geom.shape === "line"
        ? t("pick.shape.line")
        : ud.geom.shape === "polyline" && ud.geom.closed
          ? t("pick.shape.area")
          : t("pick.shape.polyline");
    }
    switch (getPick().drawingKind(id)) {
        case "line": return t("pick.shape.line");
        case "polygon": return t("pick.shape.area");
        case "drawingText":
        case "drawingTextPath": return t("pick.shape.text");
        case "drawingCircle": return t("pick.shape.circle");
        case "drawingArc": return t("pick.shape.arc");
        case "drawingImage": return t("pick.shape.image");
        default: return t("pick.kind.drawing");
    }
  };

  /** IDs ALLER 2D-Elemente nahe am Cursor (nächste zuerst). */
  const nearDrawingIds = (clientX: number, clientY: number): string[] => {
    const pxPerM = currentPxPerMeter();
    const m = rawModelAt(clientX, clientY);
    const tol = LINE_PICK_PX / pxPerM;
    const found: Array<{ id: string; d: number }> = [];
    const pick = getPick();
    for (const { i, dist } of pick.segmentsNear(m, tol)) {
      const id = (planPrimAt(plan, i) as Extract<Primitive, { kind: "line" }>).drawingId;
      if (id) found.push({ id, d: dist });
    }
    const uIdx = getUnderlayIndex();
    if (uIdx) for (const h of drawingsWithinDistance(uIdx, m, tol)) found.push({ id: h.drawing.id, d: h.dist });
    for (const { i, dpx } of pick.ringsNear(m, pxPerM, LINE_PICK_PX)) {
      found.push({ id: (planPrimAt(plan, i) as Extract<Primitive, { kind: "drawingCircle" | "drawingArc" }>).drawingId!, d: dpx / pxPerM });
    }
    const textId = pickDrawingText(clientX, clientY);
    if (textId) found.push({ id: textId, d: tol * 2 });
    const imgId = pickDrawingImage(clientX, clientY);
    if (imgId) found.push({ id: imgId, d: tol * 3 });
    found.sort((a, b) => a.d - b.d);
    return found.map((f) => f.id);
  };

  /** Alle Objekte unter dem Cursor; Eintrag 0 ist IMMER die bisherige Standardauswahl. */
  const collectCandidates = (clientX: number, clientY: number, dp: PickIds): PickCandidate[] => {
    const out: PickCandidate[] = [];
    const seen = new Set<string>();
    const add = (kind: PickKind, id: string | null | undefined, hitIndex: number | null) => {
      if (!id) return;
      const key = `${kind}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      const base = kind === "drawing" ? drawingLabel(id) : kind === "site" ? t(id === "siteRules" ? "pick.site.siteRules" : id === "viewShadows" ? "pick.site.viewShadows" : "pick.site.sunStudy") : t(`pick.kind.${kind}`);
      const cat = describePick?.(kind, id);
      out.push({ kind, id, hitIndex, label: cat ? `${base} · ${cat}` : base });
    };
    // 1) Standard-Treffer zuerst.
    add("section", dp.sectionLineId, dp.hitIndex);
    add("opening", dp.openingId, dp.hitIndex);
    add("wall", dp.wallId, dp.hitIndex);
    add("column", dp.columnId, dp.hitIndex);
    add("drawing", dp.drawingId, dp.hitIndex);
    add("solid", dp.extrudedSolidId, dp.hitIndex);
    add("tree", dp.treeId, dp.hitIndex);
    add("ceiling", dp.ceilingId, dp.hitIndex);
    add("stair", dp.stairId, dp.hitIndex);
    add("room", dp.roomId, dp.hitIndex);
    add("roof", dp.roofId, dp.hitIndex);
    add("site", dp.siteId, dp.hitIndex);
    add("context", dp.contextObjectId, dp.hitIndex);
    const first = out.slice();
    // 2) Alles Übrige an dieser Stelle, nach Standard-Priorität sortiert.
    const rest: PickCandidate[] = [];
    const addRest = (kind: PickKind, id: string | null | undefined, hitIndex: number | null) => {
      const before = out.length;
      add(kind, id, hitIndex);
      if (out.length > before) rest.push(out.pop()!);
    };
    for (const idx of hitTestAll(clientX, clientY)) {
      const p = planPrimAt(plan, idx);
      if (p?.kind !== "polygon") continue;
      addRest("opening", p.openingId, idx);
      addRest("wall", p.wallId, idx);
      addRest("column", p.columnId, idx);
      addRest("drawing", p.drawingId, idx);
      addRest("solid", p.extrudedSolidId, idx);
      addRest("ceiling", p.ceilingId, idx);
      addRest("stair", p.stairId, idx);
      addRest("room", p.roomId, idx);
      addRest("roof", p.roofId, idx);
      if (p.contextObjectId?.startsWith(TREE_PICK)) addRest("tree", p.contextObjectId.slice(TREE_PICK.length), idx);
      else if (p.contextObjectId?.startsWith("@")) addRest("site", p.contextObjectId.slice(1), idx);
      else addRest("context", p.contextObjectId, idx);
      addRest("section", p.sectionLineId, idx);
    }
    for (const id of nearDrawingIds(clientX, clientY)) addRest("drawing", id, null);
    addRest("opening", pickOpening(clientX, clientY), null);
    addRest("column", pickColumn(clientX, clientY), null);
    addRest("solid", pickExtrudedSolid(clientX, clientY), null);
    addRest("stair", pickStair(clientX, clientY), null);
    addRest("room", pickRoom(clientX, clientY), null);
    addRest("roof", pickRoof(clientX, clientY), null);
    addRest("tree", pickTree(clientX, clientY), null);
    addRest("site", pickSiteAt(clientX, clientY), null);
    addRest("context", pickContextObject(clientX, clientY), null);
    addRest("section", pickSectionLine(clientX, clientY), null);
    // Stabil nach Standard-Priorität ordnen (innerhalb einer Art bleibt die Fundreihenfolge).
    const ordered = rest
      .map((c, i) => ({ c, i }))
      .sort((a, b) => PICK_ORDER.indexOf(a.c.kind) - PICK_ORDER.indexOf(b.c.kind) || a.i - b.i)
      .map((e) => e.c);
    return [...first, ...ordered];
  };

  const applyCandidate = (
    c: PickCandidate,
    model: Vec2,
    shift: boolean,
    replaces?: { kind: PickKind; id: string },
  ) => {
    if (!onSelect) return;
    setSelected(c.hitIndex);
    onSelect({
      ...EMPTY_PICK,
      model,
      replaces,
      hitIndex: c.hitIndex,
      shift,
      wallId: c.kind === "wall" ? c.id : null,
      drawingId: c.kind === "drawing" ? c.id : null,
      ceilingId: c.kind === "ceiling" ? c.id : null,
      openingId: c.kind === "opening" ? c.id : null,
      stairId: c.kind === "stair" ? c.id : null,
      roomId: c.kind === "room" ? c.id : null,
      extrudedSolidId: c.kind === "solid" ? c.id : null,
      columnId: c.kind === "column" ? c.id : null,
      roofId: c.kind === "roof" ? c.id : null,
      sectionLineId: c.kind === "section" ? c.id : null,
      contextObjectId: c.kind === "context" ? c.id : null,
      siteId: c.kind === "site" ? c.id : null,
      treeId: c.kind === "tree" ? c.id : null,
    });
  };

  /**
   * Cmd/Strg+Klick: nächstes Objekt unter dem Cursor wählen. Liefert true, wenn
   * behandelt (sonst läuft der normale Klick weiter, z. B. bei leerer Stelle).
   */
  const cycleSelect = (e: React.PointerEvent<SVGSVGElement>): boolean => {
    const prev = cycleRef.current;
    const same =
      prev &&
      prev.plan === plan &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= 5;
    let items: PickCandidate[];
    let idx: number;
    let model: Vec2;
    if (same) {
      items = prev!.items;
      idx = (prev!.idx + 1) % items.length;
      model = prev!.model;
    } else {
      items = collectCandidates(e.clientX, e.clientY, defaultPick(e.clientX, e.clientY));
      if (items.length === 0) return false;
      idx = items.length > 1 ? 1 : 0; // erster Cmd-Klick: das Objekt UNTER dem Standard-Treffer
      const v = clientToView(e.clientX, e.clientY, view);
      model = viewToModel(v.x, v.y);
    }
    const replaces =
      e.shiftKey && same && prev?.applied && prev.applied.id !== items[idx].id
        ? { kind: prev.applied.kind, id: prev.applied.id }
        : undefined;
    cycleRef.current = {
      x: e.clientX,
      y: e.clientY,
      plan,
      items,
      idx,
      model,
      applied: e.shiftKey ? items[idx] : undefined,
      additive: e.shiftKey,
    };
    applyCandidate(items[idx], model, e.shiftKey, replaces);
    const rect = svgRef.current?.getBoundingClientRect();
    setPickList({
      x: e.clientX - (rect?.left ?? 0) + 14,
      y: e.clientY - (rect?.top ?? 0) + 14,
      items,
      idx,
    });
    return true;
  };

  /** [137] Loslassen ohne Bewegung (ohne Shift), und der Klick setzt den Klick-Zyklus fort? */
  const clickCycles = (e: React.PointerEvent, startX: number | undefined, startY: number | undefined): boolean =>
    startX !== undefined &&
    startY !== undefined &&
    !e.shiftKey &&
    Math.hypot(e.clientX - startX, e.clientY - startY) < MARQUEE_THRESHOLD_PX &&
    plainCycleNext(plainCycleRef.current, { x: e.clientX, y: e.clientY, t: Date.now(), planKey: resetKey ?? null }, selection) !== null;

  /** [137] Einfacher Klick an der Stelle des letzten Klicks: nächsten Kandidaten wählen. true = behandelt. */
  const plainCycleStep = (clientX: number, clientY: number): boolean => {
    const pc = plainCycleRef.current;
    const now = Date.now();
    const next = onSelect ? plainCycleNext(pc, { x: clientX, y: clientY, t: now, planKey: resetKey ?? null }, selection) : null;
    if (next === null || !pc) return false;
    pc.idx = next;
    pc.t = now;
    const v = clientToView(clientX, clientY, view);
    // Polygon-Index nur aus demselben Plan (sonst zeigt die lokale Hervorhebung auf ein fremdes Primitiv).
    const c = pc.items[next];
    applyCandidate(plainCyclePlan.current === plan ? c : { ...c, hitIndex: null }, viewToModel(v.x, v.y), false);
    onPickHint?.(cycleHint(pc.items.length, next));
    return true;
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    // Perf: einen anhängigen (rAF-gedrosselten) Drag mit der FINALEN Position
    // sofort anwenden, damit das Objekt exakt an der Loslass-Stelle landet, bevor
    // committet wird.
    if (dragMoveRaf.current !== null) {
      cancelAnimationFrame(dragMoveRaf.current);
      dragMoveRaf.current = null;
    }
    // [137] Klick ohne Bewegung auf einen Griff an der Stelle des letzten Klicks: nächstes Objekt statt Griff
    // bewaffnen (bei kleinem Massstab liegen die Griffe dicht, z. B. Bemassungsketten 1:500). Nichts wurde
    // gezogen — Griff ohne Änderung abschliessen.
    const gd0 = gripDrag.current?.pointerId === e.pointerId ? gripDrag.current : null;
    const ed0 = edgeDrag.current?.pointerId === e.pointerId ? edgeDrag.current : null;
    if ((gd0 || ed0) && clickCycles(e, (gd0 ?? ed0)!.startX, (gd0 ?? ed0)!.startY)) {
      gripDrag.current = null;
      edgeDrag.current = null;
      dragMovePending.current = null;
      if (gd0) gripHandlers?.onGripEnd();
      else gripHandlers?.onEdgeEnd();
      plainCycleStep(e.clientX, e.clientY);
      return;
    }
    if (
      (edgeDrag.current && edgeDrag.current.pointerId === e.pointerId) ||
      (gripDrag.current && gripDrag.current.pointerId === e.pointerId) ||
      (stampDrag.current && stampDrag.current.pointerId === e.pointerId) ||
      (moveDrag.current && moveDrag.current.pointerId === e.pointerId)
    ) {
      dragMovePending.current = {
        cx: e.clientX,
        cy: e.clientY,
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey,
        alt: e.altKey,
        pointerId: e.pointerId,
      };
      flushDragMove();
    }

    // Stempel-Griff loslassen: Ziehen abschließen.
    const sd = stampDrag.current;
    if (sd && sd.pointerId === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      stampDrag.current = null;
      return;
    }
    // Kanten-Griff: Maus loslassen beendet die Bearbeitung NICHT mehr — kein
    // Pointer-Capture gehalten, der Griff bleibt bewaffnet und folgt weiter dem
    // Cursor. Abschluss erst per erneutem Klick (oben in onPointerDown) oder
    // Enter, Verwerfen per Escape (beides im Tastatur-Effekt unten).
    if (edgeDrag.current && edgeDrag.current.pointerId === e.pointerId) {
      return;
    }

    // Editier-Griff: Maus loslassen beendet die Bearbeitung NICHT mehr — kein
    // Pointer-Capture gehalten, der Griff bleibt bewaffnet und folgt weiter dem
    // Cursor. Abschluss erst per erneutem Klick (oben in onPointerDown) oder
    // Enter, Verwerfen per Escape (beides im Tastatur-Effekt unten).
    if (gripDrag.current && gripDrag.current.pointerId === e.pointerId) {
      return;
    }

    // Körper-Verschieben loslassen.
    const md = moveDrag.current;
    if (md && md.pointerId === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      moveDrag.current = null;
      gripHandlers!.onGripEnd();
      // [137] Ohne Bewegung war es ein Klick auf das Gewählte: an derselben Stelle zum nächsten Objekt wechseln.
      if (clickCycles(e, md.startX, md.startY)) plainCycleStep(e.clientX, e.clientY);
      return;
    }

    // Aktives Zeichenwerkzeug: linke Taste loslassen = Punkt setzen (Klick).
    if (toolActive && e.button === 0) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      toolHandlers!.onToolClick(
        rawModelAt(e.clientX, e.clientY),
        currentPxPerMeter(),
        toolMods(e),
      );
      return;
    }

    // Marquee/Klick (linke Taste) abschließen.
    const mq = marquee.current;
    if (mq && mq.pointerId === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      marquee.current = null;
      if (mq.moved) {
        // Echtes Auswahl-Rechteck: Wände nach CAD-Konvention bestimmen und nach
        // oben melden. Das Rechteck stand zuletzt in marqueeRect (viewBox-Raum)
        // → in Modell-Raum umrechnen und gegen die Wand-Polygone testen.
        const cur = clientToView(e.clientX, e.clientY, view);
        const crossing = e.clientX - mq.startClientX < 0;
        const a = viewToModel(mq.startView.x, mq.startView.y);
        const b = viewToModel(cur.x, cur.y);
        const rect = {
          minX: Math.min(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxX: Math.max(a.x, b.x),
          maxY: Math.max(a.y, b.y),
        };
        if (onMarquee) {
          onMarquee({
            wallIds: getPick().marquee("wallId", rect, crossing),
            drawingIds: marqueeHitAll(rect, crossing),
            ceilingIds: getPick().marquee("ceilingId", rect, crossing),
            roomIds: getPick().marquee("roomId", rect, crossing),
            stairIds: getPick().marquee("stairId", rect, crossing),
            // [149] Bäume: Kronen-Pickfläche (`contextObjectId = "@tree:<id>"`).
            treeIds: getPick()
              .marquee("contextObjectId", rect, crossing)
              .filter((id) => id.startsWith(TREE_PICK))
              .map((id) => id.slice(TREE_PICK.length)),
            crossing,
          });
        }
        // Die lokale Einzel-Hervorhebung räumen (jetzt gilt die Mengenauswahl).
        setSelected(null);
        setMarqueeRect(null);
        return;
      }
      // Kein Drag → Klick: Objekt unter dem Cursor wählen bzw. Auswahl löschen.
      setMarqueeRect(null);
      if (onSelect && cycleModifier(e) && cycleSelect(e)) {
        plainCycleRef.current = null;
        onPickHint?.(null);
        return;
      }
      setPickList(null);
      cycleRef.current = null;
      if (!e.shiftKey && plainCycleStep(e.clientX, e.clientY)) return;
      const dp = defaultPick(e.clientX, e.clientY);
      setSelected(dp.hitIndex);
      if (onSelect) {
        const v = clientToView(e.clientX, e.clientY, view);
        onSelect({ model: viewToModel(v.x, v.y), ...dp, shift: e.shiftKey });
        // [137] Kandidaten an dieser Stelle merken: ein erneuter Klick hier wählt das nächste Objekt.
        const items = e.shiftKey ? [] : collectCandidates(e.clientX, e.clientY, dp);
        plainCycleRef.current = items.length > 1 ? { x: e.clientX, y: e.clientY, t: Date.now(), planKey: resetKey ?? null, items, idx: 0 } : null;
        plainCyclePlan.current = plan;
        onPickHint?.(cycleHint(items.length, 0));
      }
      return;
    }

    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Imperativen GL-Pan in React-State übernehmen (Ausschnitt final festschreiben).
    commitPan();
    drag.current = null;
    setDragging(false);
  };

  return {
    pickList,
    setPickList,
    hoverPick,
    setHoverPick,
    cycleRef,
    applyCandidate,
    endDrag,
  };
}
