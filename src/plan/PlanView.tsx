// Rendert einen Plan als SVG. Vektor → unendlich scharf & druckbar.
//
// Schraffuren werden aus der je Polygon aufgelösten HatchStyle-Ressource
// erzeugt (Muster, Maßstab, Winkel, Farbe, Linienstärke). Pro schraffiertem
// Polygon wird ein eigenes <pattern> in <defs> definiert, damit Maßstab/Winkel/
// Farbe variieren können.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { HatchRender, Plan, Primitive } from "./generatePlan";
import type { EdgeGrip, Vec2 } from "../model/types";
import type { DraftShape, SnapResult, ToolHandlers, ToolId, ToolMods } from "../tools/types";

const PX_PER_M = 90; // viewBox-Einheiten je Meter (Modell → SVG-Benutzerraum)
const PAD = 60; // Rand in viewBox-Einheiten

/**
 * Modell-Meter → SVG-Benutzerraum (viewBox-Einheiten) mit FIXEM Welt-Ursprung
 * am Modell-Nullpunkt (0,0): `x·PX_PER_M`, Plan-Y zeigt nach oben → SVG-Y nach
 * unten, daher `-y·PX_PER_M`. BEWUSST unabhängig von den Modell-Bounds — so
 * verschiebt sich die Abbildung NICHT, wenn sich Elemente ändern (Verschieben/
 * Löschen). Der sichtbare Ausschnitt (viewBox) bleibt dann stehen; nur manuelles
 * Pan/Zoom/Einpassen ändert ihn. (Inverse: {@link viewToModel} in der Komponente.)
 */
function toScreen(p: Vec2): Vec2 {
  return { x: p.x * PX_PER_M, y: -p.y * PX_PER_M };
}

/**
 * Papier-Massstab (docs/design/plans-output.md §3): Der Plan IST Papier-Space.
 * dpi = 96·devicePixelRatio (CSS definiert 1px = 1/96 inch). Strichstärken sind
 * in mm Papier definiert und werden über diese dpi in konstante Bildschirm-Pixel
 * umgerechnet (zusammen mit vector-effect:non-scaling-stroke bleiben sie beim
 * Zoomen papierkonstant). Live wird zusätzlich gelesen, falls sich der Monitor
 * (devicePixelRatio) ändert.
 */
const dpi = (): number => 96 * (window.devicePixelRatio || 1);
/** mm Papier → Bildschirm-Pixel (für non-scaling-stroke / dasharray). */
const mmToPx = (mm: number): number => (mm / 25.4) * dpi();
/** mm-Strichmuster → SVG dasharray in Bildschirm-Pixel (non-scaling). */
const dashMm = (dash: number[] | null | undefined): string | undefined =>
  dash && dash.length ? dash.map((d) => mmToPx(d)).join(" ") : undefined;

// Zoom-Grenzen relativ zur eingepassten Default-Ansicht. Kleinere viewBox-
// Breite = stärkerer Zoom. ZOOM_MAX → max. Hineinzoomen, ZOOM_MIN → Herauszoomen.
const ZOOM_MAX = 50; // bis 50× hinein
const ZOOM_MIN = 0.2; // bis 5× heraus
const WHEEL_STEP = 0.0015; // Empfindlichkeit des Mausrads

// Schwelle (Bildschirm-Pixel), ab der ein Links-Ziehen als Marquee gilt; darunter
// bleibt es ein Klick (Einzelwahl). Verhindert versehentliche Mini-Rechtecke.
const MARQUEE_THRESHOLD_PX = 4;

// Trefferradius (Bildschirm-Pixel) für das Greifen eines Editier-Griffs.
const GRIP_HIT_PX = 9;
// Toleranz (Bildschirm-Pixel) für die Linien-Auswahl von 2D-Zeichenelementen.
const LINE_PICK_PX = 6;

/** Rechteckiger Ausschnitt in SVG-Benutzerkoordinaten (viewBox-Einheiten). */
interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Ein Polygon mit Schraffur + die ihm zugewiesene <pattern>-ID. */
interface HatchedPoly {
  patternId: string;
  hatch: HatchRender;
}

/**
 * Imperatives Steuerhandle der Plan-Ansicht für die Oberleiste (Zoom-Buttons).
 * Die Ansicht behält Pan/Zoom intern; das Handle löst nur die fest definierten
 * Sprünge aus, ohne den sonstigen Zustand zu berühren.
 */
export interface PlanViewHandle {
  /** Auf die eingepasste Standard-Ansicht zurücksetzen (Einpassen). */
  fit: () => void;
  /**
   * Auf die aktuelle Auswahl einpassen (lokal hervorgehobenes Polygon); gibt es
   * keine Auswahl, verhält es sich wie „Einpassen".
   */
  fitSelection: () => void;
  /**
   * Den Zoom so setzen, dass das Modell im PAPIER-Massstab 1:N abgebildet wird
   * (siehe docs/design/plans-output.md §3). Hält die aktuelle Bildmitte. Wird
   * von der Oberleiste benutzt (Massstab-Preset wählen, „100 %").
   */
  applyScale: (n: number) => void;
  /** Aktuelle Pixel/Meter-Skala (für Snap-Toleranz der Command-Engine). */
  pxPerMeter: () => number;
}

/** Ergebnis eines Links-Klicks (Auswahl) an einer Modellposition. */
export interface PlanSelection {
  /** Klickposition in Modell-Metern. */
  model: Vec2;
  /** Index des getroffenen Polygon-Primitivs, oder `null` (Leerraum). */
  hitIndex: number | null;
  /**
   * ID der getroffenen Wand (aus dem Polygon-Primitiv), oder `null`, wenn der
   * Klick keine Wand traf (Leerraum bzw. ein Polygon ohne Wandbezug). Damit
   * setzt der Aufrufer (App) die Auswahl auf genau diese Wand (bzw. leert sie).
   */
  wallId: string | null;
  /**
   * ID des getroffenen 2D-Zeichenelements (Drawing2D), wenn der Klick nahe an
   * dessen Linien lag und KEINE Wand getroffen wurde; sonst `null`.
   */
  drawingId: string | null;
  /**
   * War beim Klick Shift gedrückt? Dann ERWEITERT der Aufrufer (App) die
   * Auswahl um das getroffene Element (bzw. schaltet es ab/zu), statt sie zu
   * ersetzen. Bei Leerraum-Klick mit Shift bleibt die Auswahl erhalten.
   */
  shift: boolean;
}

/**
 * Ergebnis eines Auswahl-Rechtecks (Marquee). `wallIds` ist die nach der
 * CAD-Konvention bestimmte Menge getroffener Wände (siehe `crossing`). Der
 * Aufrufer (App) ersetzt die aktuelle Auswahl durch diese Menge.
 */
export interface MarqueeSelection {
  wallIds: string[];
  /** Getroffene 2D-Zeichenelemente (gleiche window/crossing-Konvention). */
  drawingIds: string[];
  /**
   * Zieh-Richtung: `false` = links→rechts (positiv Δx) → nur VOLLSTÄNDIG
   * eingeschlossene Wände; `true` = rechts→links (negativ Δx) → auch berührte/
   * kreuzende Wände (CAD-Konvention: „crossing window").
   */
  crossing: boolean;
}

export interface PlanViewProps {
  plan: Plan;
  /**
   * Stabiler Schlüssel des Plan-Kontexts (z. B. Geschoss-/Ebenen-ID). Der
   * sichtbare Ausschnitt wird NUR auf „eingepasst" zurückgesetzt, wenn sich
   * dieser Schlüssel ändert (Plan-/Geschoss-Wechsel) — NICHT bei jeder Modell-/
   * Bounds-Änderung durch Editieren. So „wandert" die Ansicht beim Verschieben/
   * Löschen nicht mehr mit; sie ändert sich nur durch manuelles Pan/Zoom/
   * Einpassen. Fehlt der Schlüssel, bleibt der Ausschnitt nach dem ersten
   * Einpassen stehen (kein Auto-Reset).
   */
  resetKey?: string;
  /**
   * Meldet die Cursor-Position in Modell-Koordinaten (Meter) nach oben, bzw.
   * `null`, wenn der Zeiger die Fläche verlässt. Optional — ohne Callback
   * verhält sich die Ansicht wie zuvor.
   */
  onCursor?: (model: Vec2 | null) => void;
  /**
   * Meldet den aktuellen Zoom in Prozent relativ zur eingepassten Ansicht
   * (100 % = eingepasst). Optional.
   */
  onZoom?: (percent: number) => void;
  /**
   * Meldet den LIVE Papier-Massstab als Nenner N (1:N), berechnet aus dem
   * aktuellen Ausschnitt + Canvas-Größe + dpi (docs/design/plans-output.md §3).
   * Aktualisiert sich beim Wheel-Zoom/Pan/Resize. Optional.
   */
  onScale?: (n: number) => void;
  /**
   * Links-Klick (Auswahl): meldet die getroffene Wand (bzw. `hitIndex: null`
   * bei Klick in den Leerraum → Auswahl löschen). Optional. Die Ansicht
   * markiert das getroffene Polygon zusätzlich selbst (lokale Hervorhebung).
   */
  onSelect?: (selection: PlanSelection) => void;
  /**
   * Alt+Klick (Schere/Segment löschen): meldet das nahe getroffene Drawing2D plus
   * den Modellpunkt des Klicks. Der Aufrufer (App) ermittelt daraus die nächst-
   * gelegene Kante und entfernt sie. Optional. Nur ausgelöst, wenn ein 2D-Element
   * unter dem Cursor liegt (sonst no-op).
   */
  onSegmentCut?: (drawingId: string, model: Vec2) => void;
  /**
   * Aktuell ausgewählte Wand-IDs (kontrolliert von App). Die Ansicht markiert
   * ALLE Polygone JEDER dieser Wände mit einer Akzentkontur — unabhängig davon,
   * welches Band der Klick traf. Leeres Array/undefined = keine Wand-Auswahl.
   */
  selectedWallIds?: string[];
  /**
   * Links-Drag (Marquee): meldet die im Auswahl-Rechteck getroffenen Wände nach
   * der CAD-Konvention (siehe {@link MarqueeSelection}). Optional.
   */
  onMarquee?: (selection: MarqueeSelection) => void;
  /**
   * Rechts-Klick: öffnet ein Kontextmenü an der Cursorposition. Erhält die
   * Viewport-Pixel (clientX/Y) plus den Modellpunkt. Optional. Das Standard-
   * Browser-Kontextmenü wird immer unterdrückt.
   */
  onContextMenu?: (info: { clientX: number; clientY: number; model: Vec2 }) => void;
  /**
   * Aktives Zeichenwerkzeug. `"select"`/undefined = bisheriges Verhalten
   * (Auswahl/Marquee). Bei einem aktiven Zeichenwerkzeug übernimmt das Werkzeug
   * die linke Maustaste (Punkte setzen) statt der Auswahl; Pan/Zoom bleiben.
   */
  activeTool?: ToolId;
  /**
   * Übernimmt ein Zeichenwerkzeug ODER eine Transformation die linke Maustaste?
   * Wird von App berechnet (Zeichenwerkzeug aktiv ODER laufende Transformation).
   * Fehlt der Wert, wird aus `activeTool` abgeleitet (Rückwärtskompatibilität).
   */
  toolInputActive?: boolean;
  /**
   * Werkzeug-Treiber: PlanView meldet rohe Modellpunkte + Pixel/Meter hierher
   * und zeichnet den zurückgegebenen `draft` als Overlay (Vorschau + Snap-Marker).
   */
  toolHandlers?: ToolHandlers;
  /**
   * Editier-Griffe (Grips) des aktuell EINZELN selektierten Elements, in Modell-
   * Metern (Wand-Enden, 2D-Vertices/Ecken). Werden als ziehbare Quadrate
   * gezeichnet; das Ziehen meldet sich über {@link gripHandlers}. Nur im
   * Auswahl-Werkzeug sichtbar/aktiv.
   */
  grips?: Vec2[];
  /**
   * Kanten-/Seiten-Griffe (Edge Grips) des selektierten Elements: je Seite ein
   * dreieckiger Anfasser am Kanten-Mittelpunkt, dessen Spitze nach AUSSEN zeigt.
   * Ziehen meldet sich über {@link GripHandlers.onEdgeMove}. Nur sichtbar/aktiv,
   * wenn auch die Eckpunkt-Griffe aktiv sind.
   */
  edgeGrips?: EdgeGrip[];
  /**
   * „Display"-Modus: alle Plan-Linien als konstante Haarlinie (1 px) zeichnen,
   * statt der echten mm-Strichstärken (Print). Reine Darstellung.
   */
  hairline?: boolean;
  /** ID des selektierten 2D-Elements (für „Körper greifen → verschieben"). */
  selectedDrawingId?: string | null;
  /** Alle selektierten 2D-Elemente (Mehrfach-/Marquee-Auswahl) — für Hervorhebung. */
  selectedDrawingIds?: string[];
  /** Griff-Zieh-Treiber: Live-Bewegung (gesnappt) + Abschluss. */
  gripHandlers?: GripHandlers;
}

/** Treiber für das Ziehen von Editier-Griffen (von App bereitgestellt). */
export interface GripHandlers {
  onGripMove(index: number, raw: Vec2, pxPerMeter: number, mods: ToolMods): void;
  /** Ganzes Element parallel verschieben (inkrementelles Delta in Metern). */
  onMoveBody(delta: Vec2): void;
  /**
   * Eine SEITE (Kante) ziehen: verschiebt beide Vertices der Kante senkrecht
   * (nur die Normal-Komponente von `raw` wirkt; siehe App). `raw` ist der rohe
   * Modellpunkt unter dem Cursor.
   */
  onEdgeMove(edge: EdgeGrip, raw: Vec2, pxPerMeter: number, mods: ToolMods): void;
  onGripEnd(): void;
}

export const PlanView = forwardRef<PlanViewHandle, PlanViewProps>(
  function PlanView(
    {
      plan,
      resetKey,
      onCursor,
      onZoom,
      onScale,
      onSelect,
      onMarquee,
      onSegmentCut,
      onContextMenu,
      selectedWallIds,
      activeTool,
      toolInputActive,
      toolHandlers,
      grips,
      edgeGrips,
      hairline,
      selectedDrawingId,
      selectedDrawingIds,
      gripHandlers,
    },
    ref,
  ) {
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
    const { minX, minY, maxX, maxY } = plan.bounds;
    return {
      x: minX * PX_PER_M - PAD,
      y: -maxY * PX_PER_M - PAD,
      w: (maxX - minX) * PX_PER_M + PAD * 2,
      h: (maxY - minY) * PX_PER_M + PAD * 2,
    };
  }, [plan]);

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

  const svgRef = useRef<SVGSVGElement | null>(null);
  // Frische Werte in Refs spiegeln, damit das (stabile) imperative Handle und
  // der Resize-Beobachter stets den aktuellen Stand lesen (Handle hat leere Deps).
  const viewRef = useRef(view);
  viewRef.current = view;
  const defaultViewRef = useRef(defaultView);
  defaultViewRef.current = defaultView;
  const toScreenRef = useRef(toScreen);
  toScreenRef.current = toScreen;
  const planRef = useRef(plan);
  planRef.current = plan;

  // Zoom in Prozent (eingepasst = 100 %) nach oben melden: kleinere viewBox-
  // Breite = stärker hineingezoomt. Reiner Bericht; ändert die Ansicht nicht.
  useEffect(() => {
    onZoom?.((defaultView.w / view.w) * 100);
  }, [onZoom, defaultView.w, view.w]);

  // LIVE Papier-Massstab (1:N) nach oben melden. Berechnung aus der effektiven
  // meet-Skala (Bildschirm-px je viewBox-Einheit) → px je Meter → mm je Meter,
  // verglichen mit der Papier-Abbildung. Aktualisiert bei Ausschnitts-/Größen-
  // änderung; ein ResizeObserver fängt reine Größenänderungen ab.
  const reportScale = () => {
    if (!onScale) return;
    const n = scaleFromView(viewRef.current, svgRef.current);
    if (n != null && isFinite(n)) onScale(n);
  };
  useEffect(() => {
    reportScale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScale, view, plan]);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => reportScale());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScale]);

  // Imperatives Steuerhandle für die Oberleiste (Einpassen / Auswahl / Massstab).
  // Stabil (leere Deps); liest den frischen Ausschnitt + die Auswahl aus Refs.
  useImperativeHandle(
    ref,
    () => ({
      fit: () => setView(defaultViewRef.current),
      fitSelection: () => {
        const sel = selectedRef.current;
        const prim = sel !== null ? planRef.current.primitives[sel] : undefined;
        if (prim && prim.kind === "polygon") {
          setView(fitBoxFor(prim.pts, toScreenRef.current));
        } else {
          setView(defaultViewRef.current);
        }
      },
      applyScale: (n: number) => {
        const target = viewForScale(n, viewRef.current, svgRef.current);
        if (target) setView(target);
      },
      pxPerMeter: () => currentPxPerMeter(),
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
  const gripDrag = useRef<{ pointerId: number; index: number } | null>(null);
  // Transiente Kanten-Griff-Zieh-Daten (linke Taste auf einem Dreieck-Anfasser).
  // Hält den gegriffenen EdgeGrip; die Mutation läuft live über onEdgeMove.
  const edgeDrag = useRef<{ pointerId: number; edge: EdgeGrip } | null>(null);
  // Transiente „Körper verschieben"-Daten: letzter Modellpunkt, gegen den das
  // inkrementelle Delta gebildet wird (parallel-Verschiebung des Elements).
  const moveDrag = useRef<{ pointerId: number; last: Vec2 } | null>(null);

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
    const el = svgRef.current;
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
  const EDGE_GRIP_H_PX = 14;
  const EDGE_GRIP_HALF_PX = 8;
  const screenNormal = (n: Vec2): Vec2 => ({ x: n.x, y: -n.y });
  // Index des Kanten-Griffs unter dem Cursor (Bildschirm-Pixel) oder null. Die
  // Trefferfläche liegt um die Dreiecks-Mitte (etwas außerhalb der Linie).
  const edgeGripAt = (clientX: number, clientY: number): EdgeGrip | null => {
    if (!edgeGrips) return null;
    const s = meetScale(view, svgRef.current) ?? 1;
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
    (meetScale(view, svgRef.current) ?? 1) * PX_PER_M;
  // Modifikatoren eines Pointer-Events (Shift=Ortho, Ctrl/Cmd=Snap aus).
  const toolMods = (e: React.PointerEvent | React.MouseEvent) => ({
    shift: e.shiftKey,
    ctrl: e.ctrlKey || e.metaKey,
    alt: e.altKey,
  });

  // Cursor in Modell-Metern nach oben melden (für die Status-Leiste).
  const reportCursor = (clientX: number, clientY: number) => {
    if (!onCursor) return;
    const v = clientToView(clientX, clientY, view);
    onCursor(viewToModel(v.x, v.y));
  };

  // Trefferprüfung: liefert den Index des obersten Polygon-Primitivs unter dem
  // Cursor (Modellpunkt in einem Schicht-Polygon) oder null. In umgekehrter
  // Reihenfolge testen, damit das zuletzt gezeichnete (oberste) zuerst trifft.
  const hitTest = (clientX: number, clientY: number): number | null => {
    const v = clientToView(clientX, clientY, view);
    const m = viewToModel(v.x, v.y);
    const prims = plan.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims[i];
      if (p.kind === "polygon" && pointInPolygon(m, p.pts)) return i;
    }
    return null;
  };

  // Nächstgelegenes 2D-Zeichenelement (Drawing2D) zum Cursor per Linien-Nähe in
  // Bildschirm-Pixeln (zoom-unabhängige Toleranz). Liefert die drawingId oder null.
  const pickDrawing = (clientX: number, clientY: number): string | null => {
    let bestId: string | null = null;
    let bestDist = LINE_PICK_PX;
    for (const p of plan.primitives) {
      if (p.kind !== "line" || !p.drawingId) continue;
      const a = vbToClient(toScreen(p.a).x, toScreen(p.a).y);
      const b = vbToClient(toScreen(p.b).x, toScreen(p.b).y);
      const d = pointSegDistPx({ x: clientX, y: clientY }, a, b);
      if (d < bestDist) {
        bestDist = d;
        bestId = p.drawingId;
      }
    }
    return bestId;
  };

  // Liegt der Cursor auf dem KÖRPER des aktuell selektierten Elements (Wand-
  // Poché bzw. 2D-Linie)? Dann startet ein Links-Drag das Parallel-Verschieben.
  const onSelectedBody = (clientX: number, clientY: number): boolean => {
    const selWall = selectedWallIds && selectedWallIds.length === 1 ? selectedWallIds[0] : null;
    if (selWall) {
      const hi = hitTest(clientX, clientY);
      if (hi !== null) {
        const p = plan.primitives[hi];
        if (p.kind === "polygon" && p.wallId === selWall) return true;
      }
    }
    if (selectedDrawingId && pickDrawing(clientX, clientY) === selectedDrawingId) return true;
    return false;
  };

  // Maus-Schema (docs/design/context-menu.md): MITTE = schwenken (Pan),
  // LINKS = Auswahl, RECHTS = Kontextmenü, RAD = Zoom.
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
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
    if (e.button === 0 && gripsActive) {
      // Linke Taste auf einem Editier-Griff: Griff ziehen (Endpunkt verschieben).
      const gi = gripAt(e.clientX, e.clientY);
      if (gi !== null) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        gripDrag.current = { pointerId: e.pointerId, index: gi };
        return;
      }
      // Linke Taste auf einem Kanten-Anfasser (Dreieck): Seite ziehen.
      if (edgeGripsActive) {
        const eg = edgeGripAt(e.clientX, e.clientY);
        if (eg) {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          edgeDrag.current = { pointerId: e.pointerId, edge: eg };
          return;
        }
      }
      // Sonst: auf dem Körper des selektierten Elements? → Parallel-Verschieben.
      if (onSelectedBody(e.clientX, e.clientY)) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        moveDrag.current = { pointerId: e.pointerId, last: rawModelAt(e.clientX, e.clientY) };
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

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // Immer die Cursor-Position melden (auch ohne Ziehen), für die Statusleiste.
    reportCursor(e.clientX, e.clientY);

    // Kanten-Griff ziehen: rohen Modellpunkt nach oben melden (App projiziert
    // ihn auf die Kanten-Normale → Seite verschiebt sich senkrecht).
    const ed = edgeDrag.current;
    if (ed && ed.pointerId === e.pointerId) {
      gripHandlers!.onEdgeMove(
        ed.edge,
        rawModelAt(e.clientX, e.clientY),
        currentPxPerMeter(),
        toolMods(e),
      );
      return;
    }

    // Editier-Griff ziehen: gesnappten Modellpunkt nach oben melden (live).
    const gd = gripDrag.current;
    if (gd && gd.pointerId === e.pointerId) {
      gripHandlers!.onGripMove(
        gd.index,
        rawModelAt(e.clientX, e.clientY),
        currentPxPerMeter(),
        toolMods(e),
      );
      return;
    }

    // Element parallel verschieben: inkrementelles Delta gegen den letzten Punkt.
    const md = moveDrag.current;
    if (md && md.pointerId === e.pointerId) {
      const cur = rawModelAt(e.clientX, e.clientY);
      const delta = { x: cur.x - md.last.x, y: cur.y - md.last.y };
      if (delta.x !== 0 || delta.y !== 0) {
        gripHandlers!.onMoveBody(delta);
        md.last = cur;
      }
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
    if (!d || d.pointerId !== e.pointerId) return;
    const { scale } = measure(d.startView);
    // Bildschirm-Delta → viewBox-Einheiten; Inhalt folgt dem Cursor, also
    // verschiebt sich der Ausschnitt entgegengesetzt.
    const dx = (e.clientX - d.startClientX) / scale;
    const dy = (e.clientY - d.startClientY) / scale;
    setView({
      x: d.startView.x - dx,
      y: d.startView.y - dy,
      w: d.startView.w,
      h: d.startView.h,
    });
  };

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    // Kanten-Griff loslassen: Ziehen abschließen.
    const ed = edgeDrag.current;
    if (ed && ed.pointerId === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      edgeDrag.current = null;
      gripHandlers!.onGripEnd();
      return;
    }

    // Editier-Griff loslassen: Ziehen abschließen.
    const gd = gripDrag.current;
    if (gd && gd.pointerId === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      gripDrag.current = null;
      gripHandlers!.onGripEnd();
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
            wallIds: marqueeHit(plan.primitives, rect, crossing),
            drawingIds: marqueeHitDrawings(plan.primitives, rect, crossing),
            crossing,
          });
        }
        // Die lokale Einzel-Hervorhebung räumen (jetzt gilt die Mengenauswahl).
        setSelected(null);
        setMarqueeRect(null);
        return;
      }
      // Kein Drag → Klick: Wand unter dem Cursor wählen bzw. Auswahl löschen.
      setMarqueeRect(null);
      const hitIndex = hitTest(e.clientX, e.clientY);
      setSelected(hitIndex);
      if (onSelect) {
        const v = clientToView(e.clientX, e.clientY, view);
        const hit = hitIndex !== null ? plan.primitives[hitIndex] : undefined;
        const wallId = hit && hit.kind === "polygon" ? hit.wallId ?? null : null;
        // Traf der Klick KEINE Wand: zuerst eine getroffene gefüllte 2D-Fläche
        // (Polygon mit drawingId), sonst die 2D-Linien (Drawing2D) per Nähe.
        const polyDrawingId =
          hit && hit.kind === "polygon" ? hit.drawingId ?? null : null;
        const drawingId = wallId
          ? null
          : polyDrawingId ?? pickDrawing(e.clientX, e.clientY);
        onSelect({
          model: viewToModel(v.x, v.y),
          hitIndex,
          wallId,
          drawingId,
          shift: e.shiftKey,
        });
      }
      return;
    }

    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    setDragging(false);
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    setView((prev) => {
      // Punkt unter dem Cursor (bleibt nach dem Zoom ortsfest).
      const anchor = clientToView(e.clientX, e.clientY, prev);
      // Hochrollen (deltaY < 0) → hinein → kleinere viewBox.
      let factor = Math.exp(e.deltaY * WHEEL_STEP);
      // Zoom relativ zur Default-Breite begrenzen.
      const minW = defaultView.w / ZOOM_MAX;
      const maxW = defaultView.w / ZOOM_MIN;
      const targetW = clamp(prev.w * factor, minW, maxW);
      // Tatsächlich angewandter Faktor nach Klemmung (hält Seitenverhältnis).
      factor = targetW / prev.w;
      const w = prev.w * factor;
      const h = prev.h * factor;
      // x/y so anpassen, dass der Anker auf demselben Pixel bleibt.
      return {
        x: anchor.x - (anchor.x - prev.x) * factor,
        y: anchor.y - (anchor.y - prev.y) * factor,
        w,
        h,
      };
    });
  };

  // Doppelklick → bei aktivem Werkzeug den mehrteiligen Entwurf abschließen,
  // sonst wieder auf die eingepasste Standard-Ansicht.
  const onDoubleClick = () => {
    if (toolActive) {
      toolHandlers!.onToolCommit();
      return;
    }
    setView(defaultView);
  };

  // Rechtsklick: Browser-Menü unterdrücken. Bei aktivem Werkzeug mit laufendem
  // Entwurf = abschließen (CAD-üblich, KEIN Kontextmenü); sonst Kontextmenü.
  const onContextMenuHandler = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    // Bei aktivem Werkzeug/Befehl ist Rechtsklick = Enter (abschließen/wiederholen,
    // §2.3) — KEIN Kontextmenü, auch ohne laufenden Entwurf.
    if (toolActive) {
      toolHandlers!.onToolCommit();
      return;
    }
    if (!onContextMenu) return;
    const v = clientToView(e.clientX, e.clientY, view);
    onContextMenu({
      clientX: e.clientX,
      clientY: e.clientY,
      model: viewToModel(v.x, v.y),
    });
  };

  // Hervorhebungs-Konturen der Auswahl. Vorrang hat die wand-bezogene Auswahl
  // (selectedWallIds, von App kontrolliert): dann werden ALLE Bänder JEDER
  // gewählten Wand umrandet. Ohne Wand-Auswahl greift die lokale Klick-
  // Hervorhebung (ein einzelnes Polygon per hitIndex), z. B. für Polygone ohne
  // Wandbezug.
  const highlightPolys = useMemo(() => {
    const ids = selectedWallIds && selectedWallIds.length ? new Set(selectedWallIds) : null;
    if (ids) {
      return plan.primitives.filter(
        (p): p is Extract<Primitive, { kind: "polygon" }> =>
          p.kind === "polygon" && p.wallId != null && ids.has(p.wallId),
      );
    }
    if (selected !== null) {
      const p = plan.primitives[selected];
      if (p && p.kind === "polygon") return [p];
    }
    return [];
  }, [plan, selectedWallIds, selected]);

  // Hervorhebung der selektierten 2D-Zeichenelemente (Mehrfach/Marquee): alle
  // Linien-/Polygon-Primitive, deren drawingId in der Auswahl liegt, werden mit
  // Akzentkontur überzeichnet (sichtbares Feedback auch ohne Griffe).
  const highlightDrawPrims = useMemo(() => {
    const ids =
      selectedDrawingIds && selectedDrawingIds.length
        ? new Set(selectedDrawingIds)
        : null;
    if (!ids) return [];
    return plan.primitives.filter(
      (p): p is Extract<Primitive, { kind: "line" | "polygon" }> =>
        (p.kind === "line" || p.kind === "polygon") &&
        p.drawingId != null &&
        ids.has(p.drawingId),
    );
  }, [plan, selectedDrawingIds]);

  // Pro Polygon mit Linien-/Kreuz-Schraffur ein eigenes <pattern> sammeln.
  // Vollfüllung ("solid") und "none" brauchen kein Muster.
  const hatched = useMemo(() => {
    const list: HatchedPoly[] = [];
    plan.primitives.forEach((p, i) => {
      if (p.kind === "polygon" && needsPattern(p.hatch.pattern)) {
        list.push({ patternId: `hatch-${i}`, hatch: p.hatch });
      }
    });
    return list;
  }, [plan]);

  return (
    <svg
      ref={svgRef}
      className="plan-svg"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => onCursor?.(null)}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenuHandler}
      // Maus-Schema: MITTE schwenkt (grabbing), sonst Standard-Cursor (LINKS
      // wählt aus). touchAction:none, damit das Schwenken nicht scrollt.
      style={{
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
          <HatchPattern key={h.patternId} id={h.patternId} hatch={h.hatch} />
        ))}
      </defs>
      {/* Zeichenblatt-Hintergrund: deckt den aktuellen Ausschnitt (viewBox)
          vollständig — unabhängig von den Modell-Bounds (fixer Ursprung). */}
      <rect
        x={view.x}
        y={view.y}
        width={view.w}
        height={view.h}
        className="plan-bg"
      />
      {plan.primitives.map((p, i) => (
        <PrimitiveShape key={i} p={p} index={i} toScreen={toScreen} hairline={!!hairline} />
      ))}
      {/* Auswahl-Hervorhebung: alle Bänder der gewählten Wand (bzw. das lokal
          getroffene Polygon) mit Akzentkontur überzeichnen. */}
      {highlightPolys.map((poly, i) => (
        <polygon
          key={`sel-${i}`}
          className="plan-selected"
          points={poly.pts
            .map(toScreen)
            .map((s) => `${s.x},${s.y}`)
            .join(" ")}
          pointerEvents="none"
        />
      ))}
      {/* Hervorhebung der selektierten 2D-Zeichenelemente (Akzentkontur). */}
      {highlightDrawPrims.map((p, i) =>
        p.kind === "line" ? (
          <line
            key={`seld-${i}`}
            className="plan-sel-draw"
            x1={toScreen(p.a).x}
            y1={toScreen(p.a).y}
            x2={toScreen(p.b).x}
            y2={toScreen(p.b).y}
            pointerEvents="none"
          />
        ) : (
          <polygon
            key={`seld-${i}`}
            className="plan-sel-draw"
            points={p.pts
              .map(toScreen)
              .map((s) => `${s.x},${s.y}`)
              .join(" ")}
            pointerEvents="none"
          />
        ),
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
          x={marqueeRect.x}
          y={marqueeRect.y}
          width={marqueeRect.w}
          height={marqueeRect.h}
          pointerEvents="none"
        />
      )}
      {/* Editier-Griffe des selektierten Elements (Wand-Enden / 2D-Vertices):
          ziehbare Quadrate. Bildschirmkonstante Größe über die meet-Skala. */}
      {gripsActive &&
        grips!.map((g, i) => {
          const s = toScreen(g);
          const size = 6 / (meetScale(view, svgRef.current) ?? 1);
          return (
            <rect
              key={`grip-${i}`}
              className="plan-grip"
              x={s.x - size}
              y={s.y - size}
              width={size * 2}
              height={size * 2}
              pointerEvents="none"
            />
          );
        })}
      {/* Kanten-/Seiten-Griffe: je Seite ein dreieckiger Anfasser, leicht nach
          AUSSEN entlang der (bildschirm-transformierten) Normale versetzt, mit
          der Spitze nach außen. Y wird gespiegelt (toScreen spiegelt Y), damit
          das Dreieck wirklich nach außen zeigt. Größe bildschirmkonstant. */}
      {edgeGripsActive &&
        edgeGrips!.map((eg, i) => {
          const s = meetScale(view, svgRef.current) ?? 1;
          const m = toScreen(eg.mid);
          // Normale in den Bildschirmraum (Y spiegeln); auf Bildschirm-px-Größen.
          const sn = screenNormal(eg.normal);
          const hVb = EDGE_GRIP_H_PX / s; // Dreieckshöhe (nach außen)
          const halfVb = EDGE_GRIP_HALF_PX / s; // halbe Basisbreite
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
        })}
      {/* Werkzeug-Overlay: Live-Vorschau (Rubber-Band) + gesetzte Stützpunkte +
          Snap-Marker + HUD. Immer obenauf, pointerEvents none. Glyph-/Schrift-
          Größen werden über die aktuelle meet-Skala bildschirmkonstant gehalten. */}
      {toolHandlers?.draft && (
        <DraftOverlay
          draft={toolHandlers.draft}
          toScreen={toScreen}
          vbPerPx={1 / (meetScale(view, svgRef.current) ?? 1)}
        />
      )}
    </svg>
  );
});

/**
 * Zeichnet die Werkzeug-Vorschau: Vorschau-Formen (gestrichelte Akzentlinien /
 * halbtransparente Flächen), gesetzte Stützpunkte (kleine Quadrate), den aktiven
 * Snap-Marker und ein Maß-/Winkel-HUD. `vbPerPx` rechnet eine gewünschte
 * Bildschirm-Pixelgröße in viewBox-Einheiten um (bildschirmkonstante Marker).
 */
function DraftOverlay({
  draft,
  toScreen,
  vbPerPx,
}: {
  draft: { preview: DraftShape[]; vertices: Vec2[]; snap?: SnapResult | null; hud?: { at: Vec2; text: string } };
  toScreen: (v: Vec2) => Vec2;
  vbPerPx: number;
}) {
  const vertSize = 7 * vbPerPx; // halbe Kantenlänge eines Stützpunkt-Quadrats
  const markSize = 6 * vbPerPx; // halbe Kantenlänge des Snap-Markers
  const fontPx = 13 * vbPerPx;
  return (
    <g className="tool-overlay" pointerEvents="none">
      {/* Vorschau-Formen. */}
      {draft.preview.map((s, i) =>
        s.kind === "line" ? (
          <line
            key={`p${i}`}
            className="tool-preview-line"
            x1={toScreen(s.a).x}
            y1={toScreen(s.a).y}
            x2={toScreen(s.b).x}
            y2={toScreen(s.b).y}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <polygon
            key={`p${i}`}
            className="tool-preview-fill"
            points={s.pts.map(toScreen).map((p) => `${p.x},${p.y}`).join(" ")}
            vectorEffect="non-scaling-stroke"
          />
        ),
      )}
      {/* Gesetzte Stützpunkte. */}
      {draft.vertices.map((v, i) => {
        const s = toScreen(v);
        return (
          <rect
            key={`v${i}`}
            className="tool-vertex"
            x={s.x - vertSize}
            y={s.y - vertSize}
            width={vertSize * 2}
            height={vertSize * 2}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {/* Snap-Marker + optionale Ortho-Hilfslinie. */}
      {draft.snap && (
        <SnapMarker snap={draft.snap} toScreen={toScreen} size={markSize} />
      )}
      {/* HUD (Länge · Winkel) leicht versetzt über dem Cursor. */}
      {draft.hud && (
        <text
          className="tool-hud"
          x={toScreen(draft.hud.at).x + 12 * vbPerPx}
          y={toScreen(draft.hud.at).y - 12 * vbPerPx}
          fontSize={fontPx}
        >
          {draft.hud.text}
        </text>
      )}
    </g>
  );
}

/** Marker-Glyph je Snap-Art + (bei ortho) eine gestrichelte Hilfslinie. */
function SnapMarker({
  snap,
  toScreen,
  size,
}: {
  snap: SnapResult;
  toScreen: (v: Vec2) => Vec2;
  size: number;
}) {
  const s = toScreen(snap.point);
  const r = size;
  return (
    <g className="snap-marker">
      {(snap.kind === "ortho" || snap.kind === "extension") && snap.refA && (
        <line
          className="snap-helper-line"
          x1={toScreen(snap.refA).x}
          y1={toScreen(snap.refA).y}
          x2={s.x}
          y2={s.y}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {snap.kind === "grid" && (
        <circle className="snap-glyph snap-fill" cx={s.x} cy={s.y} r={r * 0.5} vectorEffect="non-scaling-stroke" />
      )}
      {snap.kind === "midpoint" && (
        <polygon
          className="snap-glyph"
          points={`${s.x},${s.y - r} ${s.x + r},${s.y + r} ${s.x - r},${s.y + r}`}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {snap.kind === "intersection" && (
        <>
          <line className="snap-glyph" x1={s.x - r} y1={s.y - r} x2={s.x + r} y2={s.y + r} vectorEffect="non-scaling-stroke" />
          <line className="snap-glyph" x1={s.x - r} y1={s.y + r} x2={s.x + r} y2={s.y - r} vectorEffect="non-scaling-stroke" />
        </>
      )}
      {(snap.kind === "center" || snap.kind === "quadrant") && (
        <circle className="snap-glyph" cx={s.x} cy={s.y} r={r} vectorEffect="non-scaling-stroke" />
      )}
      {snap.kind === "onEdge" && (
        <polygon
          className="snap-glyph"
          points={`${s.x},${s.y - r} ${s.x + r},${s.y} ${s.x},${s.y + r} ${s.x - r},${s.y}`}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {(snap.kind === "endpoint" || snap.kind === "ortho" || snap.kind === "extension") && (
        <rect
          className="snap-glyph"
          x={s.x - r}
          y={s.y - r}
          width={r * 2}
          height={r * 2}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
}

/** Wert auf [lo, hi] begrenzen. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Effektive meet-Skala (Bildschirm-px je viewBox-Einheit) für einen Ausschnitt.
 * preserveAspectRatio="xMidYMid meet" nimmt die kleinere der beiden Achsen.
 * Liefert null, solange das SVG noch nicht gemessen werden kann.
 */
function meetScale(vb: ViewBox, el: SVGSVGElement | null): number | null {
  const rect = el?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return Math.min(rect.width / vb.w, rect.height / vb.h);
}

/**
 * LIVE Papier-Massstab 1:N aus dem Ausschnitt (docs/design/plans-output.md §3):
 * 1 m belegt `scale·PX_PER_M` CSS-px; in mm = ·25.4/dpi; auf Papier 1:N sind
 * das 1000/N mm ⇒ N = 1000·dpi / (scale·PX_PER_M·25.4). Letterbox-korrekt, da
 * `scale` die tatsächliche meet-Skala ist.
 */
function scaleFromView(vb: ViewBox, el: SVGSVGElement | null): number | null {
  const scale = meetScale(vb, el);
  if (scale == null) return null;
  return (1000 * dpi()) / (scale * PX_PER_M * 25.4);
}

/**
 * Ziel-Ausschnitt, der das Modell exakt im Papier-Massstab 1:N abbildet (Inverse
 * von {@link scaleFromView}). Setzt die viewBox auf das Canvas-Seitenverhältnis
 * (kein Letterbox → horizontale wie vertikale Skala = Zielskala) und hält die
 * Bildmitte des bisherigen Ausschnitts. Ohne Messung null (kein Sprung blind).
 */
function viewForScale(
  n: number,
  prev: ViewBox,
  el: SVGSVGElement | null,
): ViewBox | null {
  const rect = el?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0 || !(n > 0)) return null;
  // Ziel-meet-Skala aus N, dann viewBox = Canvas-px / Skala (beide Achsen).
  const targetScale = (1000 * dpi()) / (n * PX_PER_M * 25.4);
  const w = rect.width / targetScale;
  const h = rect.height / targetScale;
  const cx = prev.x + prev.w / 2;
  const cy = prev.y + prev.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Einpass-Ausschnitt für ein Polygon (in Modell-Metern): dessen Bounding-Box
 * → viewBox-Einheiten (über toScreen) mit etwas Rand. Für „auf Auswahl einpassen".
 */
function fitBoxFor(pts: Vec2[], toScreen: (v: Vec2) => Vec2): ViewBox {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    const s = toScreen(p);
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const margin = Math.max(w, h) * 0.25 + PAD; // etwas Luft um die Auswahl
  return {
    x: minX - margin,
    y: minY - margin,
    w: w + margin * 2,
    h: h + margin * 2,
  };
}

/**
 * Punkt-in-Polygon (Ray-Casting, gerade Kreuzungszahl). Arbeitet in beliebigen
 * 2D-Koordinaten — hier in Modell-Metern, damit die Trefferprüfung unabhängig
 * vom Zoom ist. Rand zählt nicht garantiert; für die Wand-Auswahl ausreichend.
 */
function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
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

/** Abstand Punkt→Strecke (alle in denselben Koordinaten, hier Client-Pixel). */
function pointSegDistPx(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Achsenparalleles Rechteck in Modell-Metern (Auswahl-Marquee). */
interface ModelRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bestimmt die vom Auswahl-Rechteck getroffenen Wand-IDs nach CAD-Konvention:
 *   • crossing = false (links→rechts): nur Wände, deren Polygone VOLLSTÄNDIG im
 *     Rechteck liegen (jeder Eckpunkt enthalten).
 *   • crossing = true  (rechts→links): zusätzlich Wände, die das Rechteck nur
 *     BERÜHREN/kreuzen (Überlappung der Polygone mit dem Rechteck).
 * Getestet wird je Wand über ALLE ihre Polygon-Bänder; ein Treffer eines Bandes
 * genügt. Liefert eindeutige IDs in Auftreten-Reihenfolge.
 */
function marqueeHit(
  prims: Primitive[],
  rect: ModelRect,
  crossing: boolean,
): string[] {
  // Polygone je Wand sammeln (nur Primitive mit Wandbezug zählen für die Auswahl).
  const byWall = new Map<string, Vec2[][]>();
  for (const p of prims) {
    if (p.kind !== "polygon" || p.wallId == null) continue;
    const list = byWall.get(p.wallId);
    if (list) list.push(p.pts);
    else byWall.set(p.wallId, [p.pts]);
  }
  const out: string[] = [];
  for (const [wallId, polys] of byWall) {
    const hit = crossing
      ? polys.some((poly) => polyTouchesRect(poly, rect))
      : polys.every((poly) => polyEnclosedByRect(poly, rect));
    if (hit) out.push(wallId);
  }
  return out;
}

/**
 * Vom Auswahl-Rechteck getroffene 2D-Zeichenelement-IDs (gleiche window/crossing-
 * Konvention wie {@link marqueeHit}). Sammelt je Drawing2D ALLE seine Punkte aus
 * den Linien-/Polygon-Primitiven; crossing = irgendein Punkt/Kante im Rechteck,
 * window = alle Punkte vollständig eingeschlossen.
 */
function marqueeHitDrawings(
  prims: Primitive[],
  rect: ModelRect,
  crossing: boolean,
): string[] {
  const byDrawing = new Map<string, Vec2[]>();
  const collect = (id: string, pts: Vec2[]) => {
    const list = byDrawing.get(id);
    if (list) list.push(...pts);
    else byDrawing.set(id, [...pts]);
  };
  for (const p of prims) {
    if (p.kind === "line" && p.drawingId) collect(p.drawingId, [p.a, p.b]);
    else if (p.kind === "polygon" && p.drawingId) collect(p.drawingId, p.pts);
  }
  const out: string[] = [];
  for (const [id, pts] of byDrawing) {
    const hit = crossing
      ? polyTouchesRect(pts, rect)
      : polyEnclosedByRect(pts, rect);
    if (hit) out.push(id);
  }
  return out;
}

/** Alle Eckpunkte des Polygons liegen im Rechteck (vollständig eingeschlossen). */
function polyEnclosedByRect(poly: Vec2[], r: ModelRect): boolean {
  if (poly.length === 0) return false;
  return poly.every(
    (pt) =>
      pt.x >= r.minX && pt.x <= r.maxX && pt.y >= r.minY && pt.y <= r.maxY,
  );
}

/**
 * Polygon und Rechteck überlappen/berühren sich (crossing-Test). Wahr, wenn:
 *   • ein Polygon-Eckpunkt im Rechteck liegt, ODER
 *   • eine Rechteck-Ecke im Polygon liegt, ODER
 *   • eine Polygon-Kante eine Rechteck-Kante schneidet.
 * Deckt damit auch den Fall ab, dass das Rechteck ganz innerhalb der Wand liegt.
 */
function polyTouchesRect(poly: Vec2[], r: ModelRect): boolean {
  // 1) Polygon-Punkt im Rechteck?
  for (const pt of poly) {
    if (pt.x >= r.minX && pt.x <= r.maxX && pt.y >= r.minY && pt.y <= r.maxY) {
      return true;
    }
  }
  // 2) Rechteck-Ecke im Polygon? (Rechteck ganz in der Wand.)
  const corners: Vec2[] = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
  for (const c of corners) {
    if (pointInPolygon(c, poly)) return true;
  }
  // 3) Kanten-Schnitt Polygon × Rechteck.
  const rectEdges: [Vec2, Vec2][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    for (const [c, d] of rectEdges) {
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Orientierung des Tripels (a,b,c): >0 CCW, <0 CW, 0 kollinear. */
function cross3(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Schneiden sich die Strecken a-b und c-d (inkl. Berührung)? */
function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross3(c, d, a);
  const d2 = cross3(c, d, b);
  const d3 = cross3(a, b, c);
  const d4 = cross3(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  // Kollineare Berührung.
  if (d1 === 0 && onSegment(c, d, a)) return true;
  if (d2 === 0 && onSegment(c, d, b)) return true;
  if (d3 === 0 && onSegment(a, b, c)) return true;
  if (d4 === 0 && onSegment(a, b, d)) return true;
  return false;
}

/** Liegt p auf der Strecke a-b (bei bereits kollinearen Punkten)? */
function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** Lineare/Kreuz-Muster brauchen ein <pattern>; solid/none nicht. */
function needsPattern(pattern: HatchRender["pattern"]): boolean {
  return (
    pattern === "insulation" ||
    pattern === "diagonal" ||
    pattern === "crosshatch"
  );
}

/**
 * Übersetzt eine Linienstärke (mm) in Bildschirm-Pixel für Musterlinien.
 * Bei 0.13 mm ergibt sich ~1 px (entspricht der bisherigen Dämmungs-/
 * Diagonal-Strichstärke), damit die Schraffuren wie zuvor aussehen.
 */
const hatchStrokePx = (weightMm: number): number =>
  Math.max(0.6, weightMm * (1 / 0.13));

/** Strichmuster (mm) → SVG dasharray (px) oder undefined (durchgezogen). */
function dashArray(dash: number[] | null): string | undefined {
  if (!dash || dash.length === 0) return undefined;
  return dash.map((d) => d * (1 / 0.13)).join(" ");
}

/**
 * Ein parametrisiertes Schraffur-<pattern>. Maßstab skaliert die Kachelgröße,
 * Winkel dreht das Muster (patternTransform), Farbe/Linienstärke kommen aus dem
 * aufgelösten Hatch/LineStyle.
 */
function HatchPattern({ id, hatch }: { id: string; hatch: HatchRender }) {
  const sw = hatchStrokePx(hatch.lineWeight);
  const dashes = dashArray(hatch.dash);

  if (hatch.pattern === "insulation") {
    // Weiche Zickzack-/Wellenlinie (SIA-nah). Kachel 14×10 × Maßstab.
    const w = 14 * hatch.scale;
    const h = 10 * hatch.scale;
    const my = 5 * hatch.scale;
    const qy1 = -1 * hatch.scale;
    const qy2 = 11 * hatch.scale;
    const qx1 = 3.5 * hatch.scale;
    const qx2 = 7 * hatch.scale;
    const qx3 = 10.5 * hatch.scale;
    return (
      <pattern
        id={id}
        patternUnits="userSpaceOnUse"
        width={w}
        height={h}
        patternTransform={`rotate(${hatch.angle})`}
      >
        <path
          d={`M0 ${my} Q ${qx1} ${qy1} ${qx2} ${my} Q ${qx3} ${qy2} ${w} ${my}`}
          fill="none"
          stroke={hatch.color}
          strokeWidth={sw}
          strokeDasharray={dashes}
        />
      </pattern>
    );
  }

  // Diagonal + Crosshatch: dünne Linien, Winkel via patternTransform.
  // Kachel 8×8 × Maßstab; crosshatch fügt eine zweite, senkrechte Schar hinzu.
  const tile = 8 * hatch.scale;
  return (
    <pattern
      id={id}
      patternUnits="userSpaceOnUse"
      width={tile}
      height={tile}
      patternTransform={`rotate(${hatch.angle})`}
    >
      <line
        x1={0}
        y1={0}
        x2={0}
        y2={tile}
        stroke={hatch.color}
        strokeWidth={sw}
        strokeDasharray={dashes}
      />
      {hatch.pattern === "crosshatch" && (
        <line
          x1={0}
          y1={0}
          x2={tile}
          y2={0}
          stroke={hatch.color}
          strokeWidth={sw}
          strokeDasharray={dashes}
        />
      )}
    </pattern>
  );
}

/** Opazität gedimmter („grau") Primitive im Darstellungsmodus „andere grau". */
const GREYED_OPACITY = 0.3;

function PrimitiveShape({
  p,
  index,
  toScreen,
  hairline,
}: {
  p: Primitive;
  index: number;
  toScreen: (v: Vec2) => Vec2;
  hairline: boolean;
}) {
  // Gedimmte Elemente bekommen eine niedrige Gruppen-Opazität, sodass Strich
  // UND Füllung gleichmäßig zurücktreten (best-effort, ohne Farbumrechnung).
  const shape = renderPrimitive(p, index, toScreen, hairline);
  if (p.greyed) {
    return <g opacity={GREYED_OPACITY}>{shape}</g>;
  }
  return shape;
}

/** Konstante Haarlinien-Breite (Bildschirm-px) im Display-Modus. */
const HAIRLINE_PX = 1;

/** Erzeugt das reine SVG eines Primitivs (ohne Dimm-Hülle). */
function renderPrimitive(
  p: Primitive,
  index: number,
  toScreen: (v: Vec2) => Vec2,
  hairline: boolean,
) {
  // Display-Modus: konstante Haarlinie statt echter mm-Strichstärke.
  const weight = (mm: number) => (hairline ? HAIRLINE_PX : mmToPx(mm));
  switch (p.kind) {
    case "polygon": {
      const pts = p.pts.map(toScreen).map((s) => `${s.x},${s.y}`).join(" ");
      // Umriss-Strichstärke in mm Papier → konstante Bildschirm-px
      // (non-scaling-stroke ⇒ papierkonstant beim Zoomen).
      const sw = weight(p.strokeWidthMm);
      // Ohne Schraffur: reine Component-Füllung bzw. „none" (nur Umriss).
      if (p.hatch.pattern === "none") {
        return (
          <polygon
            points={pts}
            fill={p.fill}
            stroke={p.stroke}
            strokeWidth={sw}
            vectorEffect="non-scaling-stroke"
          />
        );
      }
      // Vollfüllung: Schraffurfarbe deckt die Component-Füllung (Poché).
      if (p.hatch.pattern === "solid") {
        return (
          <polygon
            points={pts}
            fill={p.hatch.color}
            stroke={p.stroke}
            strokeWidth={sw}
            vectorEffect="non-scaling-stroke"
          />
        );
      }
      // Linien-/Kreuz-Schraffur: erst Grundfüllung, dann Muster darüber.
      return (
        <g>
          <polygon points={pts} fill={p.fill} stroke="none" />
          <polygon
            points={pts}
            fill={`url(#hatch-${index})`}
            stroke={p.stroke}
            strokeWidth={sw}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      );
    }
    case "line": {
      const a = toScreen(p.a);
      const b = toScreen(p.b);
      // Strichstärke + Strichmuster in mm Papier (non-scaling). Die Farbe kommt
      // weiterhin aus der CSS-Klasse (z. B. .door-leaf / .wall-axis).
      return (
        <line
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          className={p.cls}
          stroke={p.color}
          strokeWidth={weight(p.weightMm)}
          strokeDasharray={dashMm(p.dash)}
          vectorEffect="non-scaling-stroke"
        />
      );
    }
    case "arc": {
      const c = toScreen(p.center);
      const from = toScreen(p.from);
      const to = toScreen(p.to);
      const r = p.r * PX_PER_M;
      // Kurzer Weg (≤180°): large-arc = 0. Drehrichtung aus Kreuzprodukt
      // im Bildschirmraum (y nach unten).
      const v1 = { x: from.x - c.x, y: from.y - c.y };
      const v2 = { x: to.x - c.x, y: to.y - c.y };
      const cross = v1.x * v2.y - v1.y * v2.x;
      const sweep = cross > 0 ? 1 : 0;
      const d = `M ${from.x} ${from.y} A ${r} ${r} 0 0 ${sweep} ${to.x} ${to.y}`;
      return (
        <path
          d={d}
          className={p.cls}
          strokeWidth={weight(p.weightMm)}
          strokeDasharray={dashMm(p.dash)}
          vectorEffect="non-scaling-stroke"
        />
      );
    }
  }
}
