// Steuerhandle (`useImperativeHandle`), Zieh-Zustände (Pan, Marquee, Griffe, Körper, Stempel), Tastatur-
// Abschluss bewaffneter Griffe, Umrechnung Bildschirm ↔ Ansicht ↔ Modell und Griff-Treffer der Plan-Ansicht
// ([165] aus `PlanView.tsx`). Aufgerufen einmal von `PlanView`.

import { useRef, useImperativeHandle, useState, useEffect, useMemo } from "react";
import { planPrimAt, fitBoxFor, viewForScale, PX_PER_M, viewForCamera, toScreen, meetScale } from "../../../core";
import type { ViewBox__plan_planView_geometry as ViewBox, ClientMap } from "../../../core";
import type { Vec2, EdgeGrip } from "../../../model/types";
import type { BodyTarget } from "./types";
import { GRIP_HIT_PX } from "./constants";
import { createCursorStore } from "../../../state/cursorStore";
import type { GripHandlers } from "./types";
import type { PlanViewHandle } from "./types";
import type { Plan } from "../../../core";

/** Werte aus `PlanView`, die dieser Hook liest (unverändert, ohne Kopie). */
export interface UsePlanCoordsArgs {
  gripHandlers: GripHandlers | undefined;
  ref: React.ForwardedRef<PlanViewHandle>;
  setView: React.Dispatch<React.SetStateAction<ViewBox>>;
  defaultViewRef: React.MutableRefObject<ViewBox>;
  planRef: React.MutableRefObject<Plan>;
  toScreenRef: React.MutableRefObject<(p: Vec2) => Vec2>;
  viewRef: React.MutableRefObject<ViewBox>;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  setPaperScale: React.Dispatch<React.SetStateAction<number | null>>;
  roomStamp: { roomId: string; anchor: Vec2; } | null | undefined;
  stampAt: Vec2 | null;
  plan: Plan;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  view: ViewBox;
  grips: Vec2[] | undefined;
  edgeGrips: EdgeGrip[] | undefined;
  onCursor: ((model: Vec2 | null) => void) | undefined;
}

export function usePlanCoords(inp: UsePlanCoordsArgs) {
  const {
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
  } = inp;

  // Frischer Spiegel der gripHandlers-Prop für das (unten stabil mit leeren
  // Deps memoisierte) Imperativ-Handle — direkt referenzieren würde die Prop
  // vom ERSTEN Render einfrieren (stale closure, s. Kommentar dort).
  const gripHandlersRef = useRef(gripHandlers);
  gripHandlersRef.current = gripHandlers;

  // Imperatives Steuerhandle für die Oberleiste (Einpassen / Auswahl / Massstab).
  // Stabil (leere Deps); liest den frischen Ausschnitt + die Auswahl aus Refs.
  useImperativeHandle(
    ref,
    () => ({
      fit: () => setView(defaultViewRef.current),
      confirmGripEdit: () => {
        // Von der Befehlszeile aus angestoßen (Enter mit leerem Eingabetext,
        // s. App.tsx) — dieselbe Aktion wie ein bestätigender Klick auf der
        // Zeichenfläche (siehe onPointerDown-Kopf unten), nur eben nicht über
        // ein Pointer-Event.
        if (gripDrag.current) {
          gripDrag.current = null;
          gripHandlersRef.current?.onGripEnd();
        }
      },
      confirmEdgeEdit: () => {
        if (edgeDrag.current) {
          edgeDrag.current = null;
          gripHandlersRef.current?.onEdgeEnd();
        }
      },
      fitSelection: () => {
        const sel = selectedRef.current;
        const prim = sel !== null ? planPrimAt(planRef.current, sel) : undefined;
        if (prim && prim.kind === "polygon") {
          setView(fitBoxFor(prim.pts, toScreenRef.current));
        } else {
          setView(defaultViewRef.current);
        }
      },
      applyScale: (n: number) => {
        const target = viewForScale(n, viewRef.current, svgRef.current);
        if (target) setView(target);
        // Diesen Massstab als stabile Referenz für die Print-Strichbreiten merken:
        // ab jetzt skalieren die Papier-mm-Linien um genau dieses N (bis der
        // nächste Massstab gewählt wird); Rad-Zoom lässt ihn unberührt.
        if (n > 0) setPaperScale(n);
      },
      // [185] Aus der frischen viewBox (Ref): `currentPxPerMeter` sähe im stabilen Handle die erste viewBox
      // (Reiter/Ausschnitte merkten sonst den Start-Zoom statt des aktuellen).
      pxPerMeter: () => (meetScale(viewRef.current, canvasRef.current ?? svgRef.current) ?? 1) * PX_PER_M,
      viewCenterModel: () => {
        // Mitte der frischen viewBox (aus Ref) → Modell (inverse toScreen).
        const v = viewRef.current;
        return { x: (v.x + v.w / 2) / PX_PER_M, y: -(v.y + v.h / 2) / PX_PER_M };
      },
      setCamera: (center, pxPerMeter) => {
        const target = viewForCamera(center, pxPerMeter, svgRef.current);
        if (target) setView(target);
      },
      fitBounds: (pts) => {
        if (pts.length === 0) return; // leerer Import → kein Fit, kein Crash
        setView(fitBoxFor(pts, toScreenRef.current));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Transiente Pan-Zieh-Daten (Mitteltaste; kein State → kein Re-Render je
  // Bewegung).
  const drag = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startView: ViewBox;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Transiente Marquee-Zieh-Daten (linke Taste). Startpunkt in viewBox-Einheiten
  // + die Bildschirm-Pixel (für die Klick-vs-Drag-Schwelle).
  const marquee = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startView: Vec2; // Startpunkt in viewBox-Einheiten
    moved: boolean; // Schwelle überschritten → echtes Rechteck (kein Klick)
  } | null>(null);
  // Aktuelles Auswahl-Rechteck in viewBox-Einheiten (für die sichtbare Kontur);
  // null = kein Marquee aktiv.
  const [marqueeRect, setMarqueeRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
    crossing: boolean;
  } | null>(null);


  // Transiente Griff-Zieh-Daten (linke Taste auf einem Grip). Kein State je
  // Bewegung; die Modell-Mutation läuft live über gripHandlers.onGripMove.
  // Anders als bei Kante/Körper braucht das Loslassen der Maus die Bearbeitung
  // NICHT mehr zu beenden: der Griff bleibt „bewaffnet" (kein Pointer-Capture),
  // folgt dem Cursor beim Schweben weiter — wie beim Zeichnen (Klick → Punkt
  // setzen, Maus bewegt sich frei, Wert tippbar, nächster Klick/Enter bestätigt,
  // Escape verwirft zur ursprünglichen Position `origin` zurück).
  const gripDrag = useRef<{ pointerId: number; index: number; origin: Vec2; startX?: number; startY?: number } | null>(
    null,
  );
  // Transiente Kanten-Griff-Zieh-Daten (linke Taste auf einem Dreieck-Anfasser).
  // Hält den gegriffenen EdgeGrip (Momentaufnahme vom Grab — sein `.mid` ist der
  // Anker für Feld-Eingabe/Escape-Revert); die Mutation läuft live über
  // onEdgeMove. Dasselbe „bewaffnet"-Verhalten wie gripDrag oben: Loslassen
  // beendet die Bearbeitung NICHT, erst ein weiterer Klick/Enter (bestätigt)
  // oder Escape (verwirft zurück auf `edge.mid`).
  const edgeDrag = useRef<{ pointerId: number; edge: EdgeGrip; startX?: number; startY?: number } | null>(null);
  // Transiente „Körper verschieben"-Daten: letzter Modellpunkt, gegen den das
  // inkrementelle Delta gebildet wird (parallel-Verschiebung des Elements).
  const moveDrag = useRef<{
    pointerId: number;
    last: Vec2;
    /** Bildschirm-Start (ohne Bewegung = Klick, [137] Klick-Zyklus). */
    startX?: number;
    startY?: number;
    target: BodyTarget;
  } | null>(null);
  // Transiente Stempel-Griff-Zieh-Daten: letzter Modellpunkt, gegen den das
  // inkrementelle Delta gebildet wird (verschiebt NUR den Raum-Stempel-Anker).
  // `offset` ([140]): Abstand der gezeichneten Lage vom Anker (Pol), einmal mit dem ersten Delta
  // übergeben — der Kern setzt den Anker auf Pol + Delta, der Stempel springt so nicht zum Pol.
  const stampDrag = useRef<{ pointerId: number; roomId: string; last: Vec2; from: Vec2 | null } | null>(
    null,
  );
  // Letzter Links-Klick (Zeit + Bildschirmposition) für die manuelle Doppelklick-
  // Erkennung auf Raum-Stempel (Pointer-Capture unterdrückt natives dblclick).
  const lastClickRef = useRef<{ t: number; x: number; y: number } | null>(null);

  // Tastatur-Abschluss eines bewaffneten Punkt- ODER Kanten-Griffs (s. gripDrag/
  // edgeDrag oben): Escape verwirft (zurück auf die Ursprungsposition), Enter
  // bestätigt die aktuelle Position — beide NUR wenn kein Eingabefeld
  // fokussiert ist (die Befehlszeile behandelt ihr eigenes Enter für getippte
  // Werte selbst, s. App.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Aktuelle Handler über die Ref lesen: `gripHandlers` ist bei jedem Render ein
      // neues Objekt — mit [gripHandlers] als Abhängigkeit wurde der Listener ständig
      // ab- und neu angehängt und verpasste Tasten in diesem Fenster (Esc wurde dann
      // von der Auswahl-Aufhebung statt vom Griff-Abbruch verbraucht).
      const gripHandlers = gripHandlersRef.current;
      const gd = gripDrag.current;
      const ed = edgeDrag.current;
      if ((!gd && !ed) || !gripHandlers) return;
      if (e.key !== "Escape" && e.key !== "Enter") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      e.preventDefault();
      if (gd) {
        gripDrag.current = null;
        if (e.key === "Escape") gripHandlers.onGripCancel(gd.index, gd.origin);
        else gripHandlers.onGripEnd();
      } else if (ed) {
        edgeDrag.current = null;
        if (e.key === "Escape") gripHandlers.onEdgeCancel(ed.edge, ed.edge.mid);
        else gripHandlers.onEdgeEnd();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Bildschirm-px-Distanz Cursor → Stempel-Griff; null = kein einzelner Raum. */
  const stampHandleAt = (clientX: number, clientY: number): string | null => {
    if (!roomStamp || !stampAt) return null;
    const s = vbToClient(toScreen(stampAt).x, toScreen(stampAt).y);
    const d = Math.hypot(clientX - s.x, clientY - s.y);
    return d <= GRIP_HIT_PX ? roomStamp.roomId : null;
  };

  // Lokale Auswahl: Index des hervorgehobenen Polygon-Primitivs (oder null).
  // Reine Darstellung; die eigentliche Wand-Auswahl meldet onSelect nach oben.
  // Beim Plan-Wechsel zurücksetzen (Indizes sind nicht mehr gültig).
  const [selected, setSelected] = useState<number | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    setSelected(null);
  }, [plan]);

  // Verhältnis viewBox-Einheiten ↔ Bildschirm-Pixel. preserveAspectRatio
  // "xMidYMid meet" passt die viewBox einheitlich (kleinerer Faktor) ein und
  // zentriert sie; daraus ergibt sich die effektive Skala + der Versatz.
  const measure = (vb: ViewBox) => {
    // Untransformierte Box (GPU-Fläche) bevorzugen: das SVG trägt während einer
    // imperativen Zoom-Geste einen CSS-Transform.
    const el = canvasRef.current ?? svgRef.current;
    const rect = el?.getBoundingClientRect();
    const pxW = rect?.width ?? vb.w;
    const pxH = rect?.height ?? vb.h;
    // Bildschirm-Pixel je viewBox-Einheit (meet = min beider Achsen).
    const scale = Math.min(pxW / vb.w, pxH / vb.h);
    const drawnW = vb.w * scale;
    const drawnH = vb.h * scale;
    // Letterbox-Versatz durch die Zentrierung.
    const offX = (pxW - drawnW) / 2;
    const offY = (pxH - drawnH) / 2;
    return { rect, scale, offX, offY };
  };

  // Cursor-Position (clientX/Y) → viewBox-Koordinaten des aktuellen Ausschnitts.
  const clientToView = (clientX: number, clientY: number, vb: ViewBox): Vec2 => {
    const { rect, scale, offX, offY } = measure(vb);
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return {
      x: vb.x + (clientX - left - offX) / scale,
      y: vb.y + (clientY - top - offY) / scale,
    };
  };

  // viewBox-Einheiten → Modell-Koordinaten in Metern (Inverse des fixen
  // toScreen): x/PX_PER_M, Plan-Y zeigt nach oben → −y/PX_PER_M.
  const viewToModel = (vbX: number, vbY: number): Vec2 => ({
    x: vbX / PX_PER_M,
    y: -vbY / PX_PER_M,
  });

  // Roher Modellpunkt (Meter) unter dem Cursor — für die Zeichenwerkzeuge.
  const rawModelAt = (clientX: number, clientY: number): Vec2 => {
    const v = clientToView(clientX, clientY, view);
    return viewToModel(v.x, v.y);
  };
  // viewBox-Koordinaten → Client-Pixel (Inverse von clientToView), für die
  // Griff-Trefferprüfung in Bildschirm-Pixeln.
  const vbToClient = (vbX: number, vbY: number): { x: number; y: number } => {
    const { rect, scale, offX, offY } = measure(view);
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return { x: left + offX + (vbX - view.x) * scale, y: top + offY + (vbY - view.y) * scale };
  };
  // Abbildung Modell → Client-Pixel (toScreen + vbToClient) für Pixel-Abfragen im Kern.
  const clientMap = (): ClientMap => {
    const { rect, scale, offX, offY } = measure(view);
    return { left: (rect?.left ?? 0) + offX, top: (rect?.top ?? 0) + offY, viewX: view.x, viewY: view.y, scale };
  };
  // Index des Griffs unter dem Cursor (Bildschirm-Pixel) oder null.
  const gripAt = (clientX: number, clientY: number): number | null => {
    if (!grips) return null;
    for (let i = 0; i < grips.length; i++) {
      const vb = toScreen(grips[i]);
      const c = vbToClient(vb.x, vb.y);
      if (Math.hypot(c.x - clientX, c.y - clientY) <= GRIP_HIT_PX) return i;
    }
    return null;
  };
  // Bildschirm-Versatz (viewBox-Einheiten) eines Kanten-Anfassers entlang seiner
  // Normale: das Dreieck sitzt etwas AUSSERHALB der Kante. Y wird gespiegelt
  // (toScreen spiegelt Y), damit „außen" am Bildschirm auch wirklich außen ist.
  // Dreieck-Höhe (nach außen) + halbe Basisbreite in Bildschirm-Pixeln. Die Basis
  // sitzt AUF der Linie (am Kanten-Mittelpunkt), die Spitze zeigt nach außen.
  // Flacher, breiter Pfeil (Apex ~124°, also flacher als 120°) statt spitzem
  // Dreieck: breitere Basis, geringere Höhe.
  const EDGE_GRIP_H_PX = 7;
  const EDGE_GRIP_HALF_PX = 9;
  const screenNormal = (n: Vec2): Vec2 => ({ x: n.x, y: -n.y });
  // Index des Kanten-Griffs unter dem Cursor (Bildschirm-Pixel) oder null. Die
  // Trefferfläche liegt um die Dreiecks-Mitte (etwas außerhalb der Linie).
  const edgeGripAt = (clientX: number, clientY: number): EdgeGrip | null => {
    if (!edgeGrips) return null;
    const s = meetScale(view, canvasRef.current ?? svgRef.current) ?? 1;
    const midOutVb = (EDGE_GRIP_H_PX * 0.45) / s; // Mitte des Dreiecks
    for (const e of edgeGrips) {
      const m = toScreen(e.mid);
      const sn = screenNormal(e.normal);
      const cVb = { x: m.x + sn.x * midOutVb, y: m.y + sn.y * midOutVb };
      const c = vbToClient(cVb.x, cVb.y);
      if (Math.hypot(c.x - clientX, c.y - clientY) <= GRIP_HIT_PX) return e;
    }
    return null;
  };
  // Aktuelle Bildschirm-Pixel pro Meter (für die zoom-unabhängige Snap-Toleranz).
  const currentPxPerMeter = (): number =>
    (meetScale(view, canvasRef.current ?? svgRef.current) ?? 1) * PX_PER_M;
  // Modifikatoren eines Pointer-Events (Shift=Ortho, Ctrl/Cmd=Snap aus).
  const toolMods = (e: React.PointerEvent | React.MouseEvent) => ({
    shift: e.shiftKey,
    ctrl: e.ctrlKey || e.metaKey,
    alt: e.altKey,
  });

  // Cursor in Modell-Metern nach oben melden (Statusleiste) und für die
  // Lineal-Marker halten — beides KEIN React-State dieser Komponente (s.
  // cursorStore.ts): sonst renderte jede Mausbewegung den ganzen Plan neu.
  const rulerCursor = useMemo(() => createCursorStore(), []);
  const setRulerCursor = rulerCursor.set;
  const reportCursor = (clientX: number, clientY: number) => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    setRulerCursor(m);
    if (!onCursor) return;
    onCursor(m);
  };

  return {
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
  };
}
