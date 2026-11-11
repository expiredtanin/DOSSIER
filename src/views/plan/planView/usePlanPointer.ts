// Zeiger-Eingabe der Plan-Ansicht ([165] aus `PlanView.tsx`): `onPointerDown`/`onPointerMove`, imperativer
// Pan/Zoom im GPU-Pfad (SVG-Transform, Frame-Drosselung), Drosselung modell-ändernder Drags und die
// Standard-Auswahl (`defaultPick`). Aufgerufen einmal von `PlanView`.

import type { MeetStore, ValueStore } from "./liveMeet";
import { cycleModifier, MARQUEE_THRESHOLD_PX, EMPTY_PICK } from "./constants";
import { useRef, useEffect } from "react";
import type { ViewBox__plan_planView_geometry as ViewBox } from "../../../core";
import { localViewBoxAttr } from "./overlayOrigin";
import { meetScale, planPrimAt } from "../../../core";
import type { PickIds } from "./types";
import type { Vec2 } from "../../../model/types";
import type { GripHandlers } from "./types";
import type { EdgeGrip } from "../../../model/types";
import type { ToolHandlers } from "../../../tools/types";
import type { BodyTarget } from "./types";
import type { Plan } from "../../../core";

/** Werte aus `PlanView`, die dieser Hook liest (unverändert, ohne Kopie). */
export interface UsePlanPointerArgs {
  gripDrag: React.MutableRefObject<{ pointerId: number; index: number; origin: Vec2; startX?: number; startY?: number; } | null>;
  gripHandlers: GripHandlers | undefined;
  edgeDrag: React.MutableRefObject<{ pointerId: number; edge: EdgeGrip; startX?: number; startY?: number; } | null>;
  toolActive: boolean;
  onStampEdit: ((roomId: string) => void) | undefined;
  lastClickRef: React.MutableRefObject<{ t: number; x: number; y: number; } | null>;
  stampHandleAt: (clientX: number, clientY: number) => string | null;
  pickRoom: (clientX: number, clientY: number) => string | null;
  drag: React.MutableRefObject<{ pointerId: number; startClientX: number; startClientY: number; startView: ViewBox; } | null>;
  view: ViewBox;
  setDragging: React.Dispatch<React.SetStateAction<boolean>>;
  onSegmentCut: ((drawingId: string, model: Vec2) => void) | undefined;
  pickDrawing: (clientX: number, clientY: number) => string | null;
  clientToView: (clientX: number, clientY: number, vb: ViewBox) => Vec2;
  viewToModel: (vbX: number, vbY: number) => Vec2;
  toolHandlers: ToolHandlers | undefined;
  rawModelAt: (clientX: number, clientY: number) => Vec2;
  currentPxPerMeter: () => number;
  toolMods: (e: React.PointerEvent | React.MouseEvent) => { shift: boolean; ctrl: boolean; alt: boolean; };
  roomStamp: { roomId: string; anchor: Vec2; } | null | undefined;
  onStampMove: ((roomId: string, delta: Vec2, from?: Vec2) => void) | undefined;
  stampDrag: React.MutableRefObject<{ pointerId: number; roomId: string; last: Vec2; from: Vec2 | null; } | null>;
  stampAt: Vec2 | null;
  gripsActive: boolean;
  gripAt: (clientX: number, clientY: number) => number | null;
  grips: Vec2[] | undefined;
  edgeGripsActive: boolean;
  edgeGripAt: (clientX: number, clientY: number) => EdgeGrip | null;
  /** [26] Kante unter dem Cursor (Kanten-Anfasser) im Ruhezustand — die Plan-Ansicht hebt sie hervor. */
  onHoverEdge?: (edge: EdgeGrip | null) => void;
  grabbedBody: (clientX: number, clientY: number) => BodyTarget | null;
  moveDrag: React.MutableRefObject<{ pointerId: number; last: Vec2; startX?: number; startY?: number; target: BodyTarget; } | null>;
  marquee: React.MutableRefObject<{ pointerId: number; startClientX: number; startClientY: number; startView: Vec2; moved: boolean; } | null>;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  overlayOriginRef: React.MutableRefObject<Vec2 | null>;
  viewRef: React.MutableRefObject<ViewBox>;
  meetStore: MeetStore;
  syncDashVar: (v: ViewBox) => void;
  viewStore: ValueStore<ViewBox>;
  wantNative: boolean;
  renderGl: ((viewBox: ViewBox, paperScaleN?: number, _textScale?: number, onSent?: () => void) => void) | ((viewBox: ViewBox, paperScaleN?: number, textScaleN?: number) => void);
  paperScaleForGl: (v: ViewBox) => number;
  textScaleForGl: () => number;
  defaultView: ViewBox;
  setView: React.Dispatch<React.SetStateAction<ViewBox>>;
  reportCursor: (clientX: number, clientY: number) => void;
  setMarqueeRect: React.Dispatch<React.SetStateAction<{ x: number; y: number; w: number; h: number; crossing: boolean; } | null>>;
  updateHoverDivide: (clientX: number, clientY: number) => void;
  measure: (vb: ViewBox) => { rect: DOMRect | undefined; scale: number; offX: number; offY: number; };
  useGpuRenderer: boolean;
  hitTest: (clientX: number, clientY: number) => number | null;
  plan: Plan;
  pickSectionLine: (clientX: number, clientY: number) => string | null;
  pickOpening: (clientX: number, clientY: number) => string | null;
  pickColumn: (clientX: number, clientY: number) => string | null;
  pickExtrudedSolid: (clientX: number, clientY: number) => string | null;
  pickTree: (clientX: number, clientY: number) => string | null;
  pickStair: (clientX: number, clientY: number) => string | null;
  pickRoof: (clientX: number, clientY: number) => string | null;
  pickSiteAt: (clientX: number, clientY: number) => string | null;
  pickContextObject: (clientX: number, clientY: number) => string | null;
}

export function usePlanPointer(inp: UsePlanPointerArgs) {
  const {
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
    onHoverEdge,
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
  } = inp;

  // Maus-Schema (docs/design/context-menu.md): MITTE = schwenken (Pan),
  // LINKS = Auswahl, RECHTS = Kontextmenü, RAD = Zoom.
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Ein Punkt- ODER Kanten-Griff ist bereits „bewaffnet" (Maus wurde
    // losgelassen, der Griff folgt seither dem Cursor) — JEDER weitere
    // Linksklick bestätigt nur die aktuelle Position, statt irgendeine andere
    // Aktion (Doppelklick, Schere, neue Auswahl, …) an derselben Stelle
    // auszulösen.
    if (e.button === 0 && gripDrag.current && gripHandlers) {
      e.preventDefault();
      gripDrag.current = null;
      gripHandlers.onGripEnd();
      return;
    }
    if (e.button === 0 && edgeDrag.current && gripHandlers) {
      e.preventDefault();
      edgeDrag.current = null;
      gripHandlers.onEdgeEnd();
      return;
    }
    // Doppelklick (zweiter Klick der Sequenz) auf einen Raum-Stempel/-Fläche →
    // Stempel-Editor öffnen. Manuell über Zeit/Abstand erkannt, weil PlanView
    // Pointer-Capture nutzt und der Browser dann kein natives `dblclick`
    // synthetisiert (bzw. `detail` nicht zuverlässig füllt).
    if (e.button === 0 && !toolActive && onStampEdit) {
      const now = Date.now();
      const prev = lastClickRef.current;
      const isDbl =
        prev &&
        now - prev.t < 400 &&
        Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 6;
      lastClickRef.current = { t: now, x: e.clientX, y: e.clientY };
      if (isDbl) {
        const rid =
          stampHandleAt(e.clientX, e.clientY) ?? pickRoom(e.clientX, e.clientY);
        if (rid) {
          e.preventDefault();
          lastClickRef.current = null;
          onStampEdit(rid);
          return;
        }
      }
    }
    if (e.button === 1) {
      // Mittlere Taste: Ausschnitt zum Ziehen einfrieren (Pan).
      e.preventDefault(); // verhindert Auto-Scroll-Modus im Browser.
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startView: view,
      };
      setDragging(true);
      return;
    }
    if (e.button === 0 && e.altKey && onSegmentCut) {
      // Alt+Klick = Schere: getroffenes 2D-Element bestimmen und Segment-Löschen
      // an App melden (App ermittelt die nächstgelegene Kante aus dem Modellpunkt).
      const id = pickDrawing(e.clientX, e.clientY);
      if (id) {
        e.preventDefault();
        const v = clientToView(e.clientX, e.clientY, view);
        onSegmentCut(id, viewToModel(v.x, v.y));
        return;
      }
      // Kein 2D-Element getroffen → wie ein normaler Klick weiterbehandeln.
    }
    if (e.button === 0 && toolActive) {
      // Aktives Zeichenwerkzeug: linke Taste setzt Punkte (kein Marquee). Capture,
      // damit move/up zuverlässig ankommen; sofort eine Vorschau anstoßen.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      toolHandlers!.onToolMove(
        rawModelAt(e.clientX, e.clientY),
        currentPxPerMeter(),
        toolMods(e),
      );
      return;
    }
    if (e.button === 0 && !toolActive && roomStamp && onStampMove) {
      // Linke Taste auf dem Stempel-Griff: NUR den Stempel-Anker verschieben.
      const rid = stampHandleAt(e.clientX, e.clientY);
      if (rid) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        stampDrag.current = {
          pointerId: e.pointerId,
          roomId: rid,
          last: rawModelAt(e.clientX, e.clientY),
          // [140] Der Kern verschiebt ab der gezeichneten Lage (ohne eigenen Anker rückt der Plan den Stempel vom Pol weg).
          from: stampAt,
        };
        return;
      }
    }
    if (e.button === 0 && gripsActive) {
      // Linke Taste auf einem Editier-Griff: Griff ziehen (Endpunkt verschieben).
      const gi = gripAt(e.clientX, e.clientY);
      if (gi !== null) {
        e.preventDefault();
        // KEIN Pointer-Capture: der Griff bleibt nach dem Loslassen bewaffnet
        // und folgt via normalem Hover-onPointerMove weiter dem Cursor (s.
        // Kommentar an der gripDrag-Deklaration).
        gripDrag.current = { pointerId: e.pointerId, index: gi, origin: grips![gi], startX: e.clientX, startY: e.clientY };
        return;
      }
      // Linke Taste auf einem Kanten-Anfasser (Dreieck): Seite ziehen. KEIN
      // Pointer-Capture — dasselbe „bewaffnet nach Loslassen"-Verhalten wie
      // beim Punkt-Griff (s. Kommentar an der edgeDrag-Deklaration).
      if (edgeGripsActive) {
        const eg = edgeGripAt(e.clientX, e.clientY);
        if (eg) {
          e.preventDefault();
          edgeDrag.current = { pointerId: e.pointerId, edge: eg, startX: e.clientX, startY: e.clientY };
          return;
        }
      }
      // Sonst: auf dem Körper eines gewählten Elements? → Parallel-Verschieben.
      // Cmd/Strg+Klick = nächstes Objekt wählen, NICHT den gewählten Körper greifen.
      const body = cycleModifier(e) ? null : grabbedBody(e.clientX, e.clientY);
      if (body) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        moveDrag.current = { pointerId: e.pointerId, last: rawModelAt(e.clientX, e.clientY), target: body, startX: e.clientX, startY: e.clientY };
        return;
      }
    }
    // Körper-Verschieben auch bei MEHRFACHAUSWAHL (dann sind die einzel-Element-
    // Griffe inaktiv): Links-Drag auf einem gewählten Körper verschiebt es; die
    // koinzidenten Enden der übrigen gewählten Elemente wandern mit (App).
    if (e.button === 0 && !toolActive && !!gripHandlers && !gripsActive) {
      // Cmd/Strg+Klick = nächstes Objekt wählen, NICHT den gewählten Körper greifen.
      const body = cycleModifier(e) ? null : grabbedBody(e.clientX, e.clientY);
      if (body) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        moveDrag.current = { pointerId: e.pointerId, last: rawModelAt(e.clientX, e.clientY), target: body, startX: e.clientX, startY: e.clientY };
        return;
      }
    }
    if (e.button === 0) {
      // Linke Taste: Auswahl-Geste beginnen. Ob daraus ein Klick (eine Wand
      // wählen) oder ein Marquee (Mengenauswahl) wird, entscheidet sich erst
      // beim Loslassen anhand der zurückgelegten Strecke (Schwelle in
      // onPointerMove). Startpunkt in viewBox-Einheiten festhalten.
      e.currentTarget.setPointerCapture(e.pointerId);
      const start = clientToView(e.clientX, e.clientY, view);
      marquee.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startView: start,
        moved: false,
      };
      return;
    }
    // Rechte Taste (button 2): Kontextmenü läuft über onContextMenu.
  };

  // Perf: modell-mutierende Drags (Griff/Kante/Körper/Stempel) auf EIN Update je
  // Animationsframe drosseln. Schnelles Ziehen feuert pointermove schneller, als
  // der Plan neu gebaut/gezeichnet werden kann — ungebremst staut sich ein
  // Rückstand ("kommt nicht hinterher"). Wir merken nur die NEUESTE Position und
  // verarbeiten sie einmal pro Frame.
  const dragMovePending = useRef<{
    cx: number;
    cy: number;
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    pointerId: number;
  } | null>(null);
  const dragMoveRaf = useRef<number | null>(null);

  // Imperativer GL-Pan/Zoom: während der Geste NICHT setView pro Frame (das würde
  // die ganze PlanView neu rendern). GL-Matrix wird pro Frame aktualisiert; das
  // SVG-Overlay bekommt statt eines viewBox-Neusatzes (→ Cairo-Re-Raster in
  // WebKitGTK, teuer!) einen GPU-komponierten CSS-`transform`. React-State (view)
  // + echtes viewBox werden erst beim Loslassen abgeglichen → in WebKit KEIN
  // SVG-Re-Raster je Frame mehr.
  const panPending = useRef<ViewBox | null>(null);
  // true, wenn das SVG-Overlay zu schwer fürs Neu-Rastern je Frame ist (s. applySvgTransform).
  const overlayHeavyRef = useRef(false);
  const panStartView = useRef<ViewBox | null>(null); // viewBox bei Gestenbeginn (V0)
  const panRaf = useRef<number | null>(null);

  // Ausstehende imperative Pan-Aufräumung beim Unmount.
  useEffect(() => {
    return () => {
      if (panRaf.current !== null) cancelAnimationFrame(panRaf.current);
    };
  }, []);

  /**
   * CSS-transform, der das SVG (fest gezeichnet mit viewBox V0) so verschiebt/
   * skaliert, dass es exakt den Ziel-Ausschnitt V zeigt — deckungsgleich mit der
   * GL-Ebene (beide nutzen xMidYMid meet in dieselbe Elementbox).
   */
  const applySvgTransform = (v0: ViewBox, v: ViewBox) => {
    const svg = svgRef.current;
    if (!svg) return;
    // Box der (untransformierten) GPU-Fläche: das SVG trägt selbst schon den
    // Transform der laufenden Geste (Zoom skaliert seine gemessene Box).
    const rect = (canvasRef.current ?? svg).getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const m = Math.min(rect.width / v0.w, rect.height / v0.h); // meet-Skala bei V0
    const A = v0.w / v.w; // Zoomfaktor (uniform)
    const lbX = (rect.width - v0.w * m) / 2; // Letterbox-Offset (0 bei passendem Aspekt)
    const lbY = (rect.height - v0.h * m) / 2;
    const cx = m * A * (v0.x - v.x) + (1 - A) * lbX;
    const cy = m * A * (v0.y - v.y) + (1 - A) * lbY;
    if (!overlayHeavyRef.current) {
      // Leichtes Overlay: den echten viewBox setzen — der Vektor wird in jedem
      // Frame SCHARF neu gerastert (ein CSS-Transform würde die Ebene als Bitmap
      // strecken → verpixelt). Bildschirmkonstante Griffe skalieren dabei mit.
      svg.style.transform = "";
      svg.setAttribute("viewBox", localViewBoxAttr(v, overlayOriginRef.current ?? { x: 0, y: 0 }));
      return;
    }
    // Schweres Overlay (z. B. riesiger Auswahlpfad): GPU-komponierter CSS-Transform.
    svg.style.transformOrigin = "0 0";
    svg.style.transform = `translate(${cx}px, ${cy}px) scale(${A})`;
  };

  const flushPan = () => {
    panRaf.current = null;
    const v = panPending.current;
    const v0 = panStartView.current;
    if (!v || !v0) return;
    viewRef.current = v; // abgeleitete Reads (Snap-Toleranz etc.) frisch halten
    // Overlay (SVG-Ausschnitt mit Raumstempeln/Textfeldern, Griffe/Fangpunkt-Grösse,
    // Lineal) wird im SELBEN Takt wie die Geometrie angewendet ([145]): bei der
    // nativen Fläche in dem Moment, in dem ihr Frame abgeschickt wird (sie zeichnet
    // ihn sofort) — NICHT erst bei der Antwort, sonst malte die Webview das Overlay
    // einen Frame später und die Texte liefen beim Zoomen hinter den Linien her.
    // Wartet ein Frame (Fläche noch beschäftigt), folgt das Overlay erst mit dessen
    // Versand; verworfene Zwischen-Frames setzen es nie.
    const apply = () => {
      if (panPending.current !== v) return; // überholt oder bereits festgeschrieben
      applySvgTransform(v0, v); // SVG: echter viewBox (scharf) bzw. CSS-Transform
      meetStore.set(meetScale(v, canvasRef.current ?? svgRef.current));
      syncDashVar(v);
      viewStore.set(v);
    };
    if (wantNative) {
      (renderGl as (vb: ViewBox, ps: number, ts: number, onSent: () => void) => void)(
        v,
        paperScaleForGl(v),
        textScaleForGl(),
        apply,
      );
    } else {
      renderGl(v, paperScaleForGl(v), textScaleForGl()); // GL exakt auf V (Strich in echten Papier-mm)
      apply();
    }
  };
  /** Pan-/Zoom-Ziel imperativ anwenden (rAF-gedrosselt), ohne React-Render. */
  const enqueuePan = (v: ViewBox) => {
    if (!panStartView.current) panStartView.current = { ...viewRef.current };
    panPending.current = v;
    if (panRaf.current === null) panRaf.current = requestAnimationFrame(flushPan);
  };
  useEffect(() => {
    if (panPending.current === null) {
      meetStore.set(null);
      viewStore.set(null);
    }
  }, [view, meetStore, viewStore]);
  /**
   * Griff-Grösse in Bildschirm-px: bewusst nur SCHWACH zoomabhängig (Exponent 0.2,
   * begrenzt) — kein hartes Konstant-Bleiben, damit man an den Griffen noch merkt,
   * ob man nah oder weit weg ist, aber ohne dass sie beim Zoomen mitwachsen.
   */
  const gripK = (meet: number): number => {
    const ref = meetScale(defaultView, canvasRef.current ?? svgRef.current) ?? meet;
    return Math.min(1.4, Math.max(0.7, Math.pow(meet / ref, 0.2)));
  };
  /** Anhängigen imperativen Pan in React-State übernehmen (+ Transform lösen). */
  const commitPan = () => {
    if (panRaf.current !== null) {
      cancelAnimationFrame(panRaf.current);
      panRaf.current = null;
    }
    if (panPending.current) {
      // SVG-Transform lösen; setView setzt das echte viewBox (ein einziger Re-Raster).
      if (svgRef.current) svgRef.current.style.transform = "";
      setView(panPending.current);
      // Live-Werte NICHT sofort löschen: bis der neue `view` gerendert ist, würden
      // Griffe/Lineal sonst kurz mit dem ALTEN Ausschnitt gezeichnet (Flackern);
      // der Effekt unten räumt sie nach dem Render ab.
      panPending.current = null;
    }
    panStartView.current = null;
  };

  const flushDragMove = () => {
    dragMoveRaf.current = null;
    const p = dragMovePending.current;
    dragMovePending.current = null;
    if (!p) return;
    const mods = { shift: p.shift, ctrl: p.ctrl, alt: p.alt };
    const raw = rawModelAt(p.cx, p.cy);
    const ed = edgeDrag.current;
    if (ed && ed.pointerId === p.pointerId) {
      gripHandlers!.onEdgeMove(ed.edge, raw, currentPxPerMeter(), mods);
      return;
    }
    const gd = gripDrag.current;
    if (gd && gd.pointerId === p.pointerId) {
      gripHandlers!.onGripMove(gd.index, raw, currentPxPerMeter(), mods);
      return;
    }
    const sd = stampDrag.current;
    if (sd && sd.pointerId === p.pointerId) {
      const delta = { x: raw.x - sd.last.x, y: raw.y - sd.last.y };
      if ((delta.x !== 0 || delta.y !== 0) && onStampMove) {
        onStampMove(sd.roomId, delta, sd.from ?? undefined);
        sd.from = null;
        sd.last = raw;
      }
      return;
    }
    const md = moveDrag.current;
    if (md && md.pointerId === p.pointerId) {
      const delta = { x: raw.x - md.last.x, y: raw.y - md.last.y };
      if (delta.x !== 0 || delta.y !== 0) {
        gripHandlers!.onMoveBody(delta, md.target, mods, currentPxPerMeter());
        md.last = raw;
      }
      return;
    }
  };
  const enqueueDragMove = (e: React.PointerEvent<SVGSVGElement>) => {
    dragMovePending.current = {
      cx: e.clientX,
      cy: e.clientY,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      pointerId: e.pointerId,
    };
    if (dragMoveRaf.current === null) {
      dragMoveRaf.current = requestAnimationFrame(flushDragMove);
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // Immer die Cursor-Position melden (auch ohne Ziehen), für die Statusleiste.
    reportCursor(e.clientX, e.clientY);

    // Modell-mutierende Drags (Kante/Griff/Stempel/Körper): auf rAF drosseln —
    // ein Update je Frame mit der jeweils neuesten Position (siehe flushDragMove).
    if (
      (edgeDrag.current && edgeDrag.current.pointerId === e.pointerId) ||
      (gripDrag.current && gripDrag.current.pointerId === e.pointerId) ||
      (stampDrag.current && stampDrag.current.pointerId === e.pointerId) ||
      (moveDrag.current && moveDrag.current.pointerId === e.pointerId)
    ) {
      enqueueDragMove(e);
      return;
    }

    // Aktives Zeichenwerkzeug: Hover/Drag liefert die Live-Vorschau + Snap-Marker.
    // Mittlere Taste (Pan) bleibt davon unberührt (eigener Zweig unten).
    if (toolActive && drag.current === null) {
      toolHandlers!.onToolMove(
        rawModelAt(e.clientX, e.clientY),
        currentPxPerMeter(),
        toolMods(e),
      );
      return;
    }

    // Marquee (linke Taste) aufziehen: Rechteck in viewBox-Einheiten vom
    // Startpunkt zum aktuellen Cursor. Erst ab einer kleinen Pixel-Schwelle gilt
    // es als Drag (sonst bleibt es ein Klick → Einzelwahl beim Loslassen).
    const mq = marquee.current;
    if (mq && mq.pointerId === e.pointerId) {
      const dxPx = e.clientX - mq.startClientX;
      const dyPx = e.clientY - mq.startClientY;
      if (!mq.moved && Math.hypot(dxPx, dyPx) < MARQUEE_THRESHOLD_PX) return;
      mq.moved = true;
      const cur = clientToView(e.clientX, e.clientY, view);
      // crossing-Richtung aus dem Vorzeichen von Δx am Bildschirm (rechts→links
      // = negativ = berührend). Bildschirm-x und viewBox-x sind gleichläufig.
      const crossing = dxPx < 0;
      setMarqueeRect({
        x: Math.min(mq.startView.x, cur.x),
        y: Math.min(mq.startView.y, cur.y),
        w: Math.abs(cur.x - mq.startView.x),
        h: Math.abs(cur.y - mq.startView.y),
        crossing,
      });
      return;
    }

    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) {
      // Echter Ruhezustand (kein Drag/Werkzeug/Marquee/Pan) — Hover-
      // Teilpunkte-Erkennung.
      updateHoverDivide(e.clientX, e.clientY);
      onHoverEdge?.(edgeGripsActive ? edgeGripAt(e.clientX, e.clientY) : null);
      return;
    }
    const { scale } = measure(d.startView);
    // Bildschirm-Delta → viewBox-Einheiten; Inhalt folgt dem Cursor, also
    // verschiebt sich der Ausschnitt entgegengesetzt.
    const dx = (e.clientX - d.startClientX) / scale;
    const dy = (e.clientY - d.startClientY) / scale;
    const next: ViewBox = {
      x: d.startView.x - dx,
      y: d.startView.y - dy,
      w: d.startView.w,
      h: d.startView.h,
    };
    // GL-Pfad: imperativ (rAF, kein React-Render pro Frame). SVG-Pfad: wie bisher
    // über setView (das SVG muss über React neu rendern).
    if (useGpuRenderer) enqueuePan(next);
    else setView(next);
  };

  // Standard-Auswahl an einer Stelle (genau die BISHERIGE Prioritätskette: Schnitt-
  // linie > Öffnung > Wand > Stütze > 2D > Körper > Decke > Treppe > Raum > Dach >
  // Kontext). Liefert nur die Ids + Polygon-Index; `model`/`shift` ergänzt der Aufrufer.
  const defaultPick = (clientX: number, clientY: number): PickIds => {
    const hitIndex = hitTest(clientX, clientY);
    const hit = hitIndex !== null ? planPrimAt(plan, hitIndex) : undefined;
    // Öffnung (Fenster/Tür) zuerst: ihr Symbol sitzt in der ausgesparten Lücke
    // bzw. schlägt über die Wand — ein Klick nahe am Symbol wählt die Öffnung.
    // Schnitt-/Ansichtslinie zuerst: ihr schmales Band liegt über allem, ein
    // Klick genau darauf meint die Linie (nicht die darunterliegende Wand) —
    // dann sofort melden (kein anderes Element konkurriert).
    const sectionLineId = pickSectionLine(clientX, clientY);
    if (sectionLineId) {
      return { ...EMPTY_PICK, hitIndex, sectionLineId };
    }
    const openingId = pickOpening(clientX, clientY);
    const wallId =
      openingId ? null : hit && hit.kind === "polygon" ? hit.wallId ?? null : null;
    // Stütze (Tragwerk): ihre Querschnitt-Poché liegt ÜBER der Wand-Poché —
    // ein direkter Klick auf sie trifft zuerst die Stütze (hit.columnId), sonst
    // die Fläche per Punkt-in-Polygon. Priorität direkt nach Öffnung/Wand.
    const polyColumnId =
      hit && hit.kind === "polygon" ? hit.columnId ?? null : null;
    const columnId =
      openingId || wallId
        ? null
        : polyColumnId ?? pickColumn(clientX, clientY);
    // Traf der Klick KEINE Wand/Öffnung/Stütze: zuerst eine getroffene gefüllte
    // 2D-Fläche (Polygon mit drawingId), sonst die 2D-Linien (Drawing2D) per Nähe.
    const polyDrawingId =
      hit && hit.kind === "polygon" ? hit.drawingId ?? null : null;
    const drawingId =
      openingId || wallId || columnId
        ? null
        : polyDrawingId ?? pickDrawing(clientX, clientY);
    // Extrudierter Körper (truck-Integration): sein Footprint-Umriss ersetzt
    // die frühere Drawing2D-Fläche, also gleiche Priorität wie drawingId.
    const polyExtrudedSolidId =
      hit && hit.kind === "polygon" ? hit.extrudedSolidId ?? null : null;
    const extrudedSolidId =
      openingId || wallId || columnId || drawingId
        ? null
        : polyExtrudedSolidId ?? pickExtrudedSolid(clientX, clientY);
    // [149] Baum (Kronenfläche) vor Decke, Raum, Dach und Gelände.
    const treeId =
      openingId || wallId || columnId || drawingId || extrudedSolidId ? null : pickTree(clientX, clientY);
    // Decke nur, wenn weder Öffnung/Wand noch 2D-Element getroffen wurde. Da die
    // Decken-Polygone UNTER der Wand-Poché liegen, trifft ein direkter Klick
    // auf die Wand zuerst die Wand; freie Deckenfläche trifft die Decke.
    const hitCeilingId =
      hit && hit.kind === "polygon" ? hit.ceilingId ?? null : null;
    const ceilingId =
      openingId || wallId || columnId || drawingId || extrudedSolidId || treeId ? null : hitCeilingId;
    // Treppe nur, wenn nichts anderes getroffen wurde (Tritte liegen frei).
    const stairId =
      openingId || wallId || columnId || drawingId || extrudedSolidId || treeId || ceilingId
        ? null
        : pickStair(clientX, clientY);
    // Raum als vorletzte Priorität: die Raum-Fläche liegt UNTER allem anderen.
    const roomId =
      openingId || wallId || columnId || drawingId || extrudedSolidId || treeId || ceilingId || stairId
        ? null
        : pickRoom(clientX, clientY);
    // Dach als LETZTE Priorität: die Traufe-Fläche deckt den ganzen Grundriss
    // ab, daher erst wählen, wenn wirklich nichts anderes getroffen wurde.
    const roofId =
      openingId || wallId || columnId || drawingId || extrudedSolidId || treeId || ceilingId || stairId || roomId
        ? null
        : pickRoof(clientX, clientY);
    // Kontext-Objekt (Gebäude/Terrain) als ALLERLETZTE Priorität — seine
    // Bbox-Pick-Fläche kann grosszügig überlappen, daher erst wenn wirklich
    // nichts anderes getroffen wurde.
    // [137] Schatten/Baurechtslinien (Lage-Darstellung) über dem Gelände, unter allen Bauteilen.
    const siteId =
      openingId || wallId || columnId || drawingId || extrudedSolidId || treeId || ceilingId || stairId || roomId || roofId
        ? null
        : pickSiteAt(clientX, clientY);
    const contextObjectId =
      openingId || wallId || columnId || drawingId || extrudedSolidId || treeId || ceilingId || stairId || roomId || roofId || siteId
        ? null
        : pickContextObject(clientX, clientY);
    return {
      hitIndex,
      wallId,
      drawingId,
      ceilingId,
      openingId,
      stairId,
      roomId,
      extrudedSolidId,
      columnId,
      roofId,
      sectionLineId: null,
      contextObjectId,
      siteId,
      treeId,
    };
  };

  return {
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
  };
}
