// Layout-Blatt als erstklassige Ansicht im HAUPT-Viewport (Phase 2b) — das Blatt
// liegt auf einem papierartigen „Tisch", ist pan-/zoombar (Zoom-to-Cursor) und
// die platzierten Viewports lassen sich mit der Maus platzieren/verschieben/
// skalieren/löschen (wie ArchiCAD/Vectorworks). Der Render-Kern (echter Plan je
// Viewport, Master-Titelblock) lebt hier zentral (ViewportPlan, TitleBlockSvg
// unten) und ersetzt das frühere schwebende Layout-Fenster (Phase 2a).
//
// Geometrie/Transform/Trefferlogik liegen rein + testbar in layoutSheetMath.ts.
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  CSSProperties,
} from "react";
import type {
  Layout,
  LayoutAnnotation,
  LayoutAnnotationPatch,
  LayoutOrientation,
  LayoutPaperFormat,
  LayoutViewport,
  Project,
} from "../model/types";
import { generatePlan } from "../plan/generatePlan";
import { planToPrintSvg } from "../export/planToPrintSvg";
import {
  effectiveSheetSizeMm,
  findMaster,
  findSnapshot,
  resolveTitleBlock,
  resolveViewportScale,
  visibleCodesFromSnapshot,
} from "../panels/layoutModel";
import {
  annotationBoundsMm,
  applyHandleDrag,
  applyLineHandleDrag,
  clampRectToSheet,
  fitTransform,
  handleAnchors,
  handleCursor,
  lineHandleAnchors,
  mmToScreen,
  normalizeRect,
  panBy,
  pickAnnotationHandle,
  pickViewport,
  screenToMm,
  translateAnnotation,
  vpRect,
  zoomAtCursor,
  type AnnotHandleHit,
  type Handle,
  type LineHandle,
  type RectMm,
  type SheetTransform,
} from "./layoutSheetMath";
import { RichTextEditor } from "../text/RichTextEditor";
import { docFromText } from "../text/richText";
import { wrapDocToLines, type SvgLine } from "../text/renderHtml";
import { contentFontBaselineFromTop, TEXT_LINE_HEIGHT_MULT } from "../text/fontMetrics";
import { readImageFile, defaultImageSizeMm } from "../io/imageAsset";
import { rasterizePdfPages } from "../io/pdfImport";
import type { ToolId } from "../tools/types";
import { t } from "../i18n";

// ── Geteilter Render-Kern (auch vom schwebenden LayoutEditor genutzt) ─────────

/**
 * Rendert den ECHTEN Plan eines Viewports: Ausschnitt auflösen → `generatePlan`
 * → `planToPrintSvg` beim effektiven Viewport-Massstab, Blattgrösse = Viewport-
 * mm-Grösse. Das SVG (viewBox in mm) wird per 100 % in den Rahmen skaliert
 * (`overflow:hidden` → Clipping). Neu-Aufbau nur bei relevanten Änderungen
 * (Projekt/Bindung/Grösse/Massstab), NICHT beim Verschieben (x/y) oder Zoomen.
 */
export function ViewportPlan({
  project,
  viewport,
}: {
  project: Project;
  viewport: LayoutViewport;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const snap = findSnapshot(project, viewport.snapshotId);
    if (!snap) {
      el.replaceChildren();
      return;
    }
    try {
      const codes = visibleCodesFromSnapshot(snap);
      // Massstab ZUERST auflösen: er geht in die Plan-Erzeugung ein, weil
      // Bemassungs-Feinheiten in Papier-mm angegeben sind (s. model/dimension.ts).
      const scaleN = resolveViewportScale(viewport, snap);
      const plan = generatePlan(
        project,
        snap.activeLevelId,
        codes,
        undefined,
        snap.detail,
        false,
        false,
        true,
        scaleN,
      );
      const print = planToPrintSvg(plan, {
        scaleDenominator: scaleN,
        pageWidthMm: viewport.widthMm,
        pageHeightMm: viewport.heightMm,
      });
      const svg = print.svg;
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.style.display = "block";
      el.replaceChildren(svg);
    } catch {
      el.replaceChildren();
    }
  }, [
    project,
    viewport.snapshotId,
    viewport.widthMm,
    viewport.heightMm,
    viewport.scaleDenominator,
  ]);
  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}

/**
 * Schlichtes Schriftfeld unten rechts (mm-Koordinaten des Blatt-viewBox) mit den
 * aufgelösten Master-Werten — dieselbe Anmutung wie der PDF-Titelblock.
 */
export function TitleBlockSvg({
  sheet,
  tb,
  paper,
  orientation,
}: {
  sheet: { w: number; h: number };
  tb: { projectName: string; sheetName: string; scale: string; date: string; author: string };
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
}) {
  const boxW = 70;
  const boxH = 30;
  const pad = 6;
  const x = sheet.w - boxW - pad;
  const y = sheet.h - boxH - pad;
  const fmt = `${paper.toUpperCase()} ${orientation === "landscape" ? "quer" : "hoch"}`;
  return (
    <g>
      <rect x={x} y={y} width={boxW} height={boxH} fill="#ffffff" stroke="#111111" strokeWidth={0.35} />
      <line x1={x} y1={y + 8} x2={x + boxW} y2={y + 8} stroke="#111111" strokeWidth={0.2} />
      <line x1={x} y1={y + boxH - 7} x2={x + boxW} y2={y + boxH - 7} stroke="#111111" strokeWidth={0.2} />
      <text x={x + 3} y={y + 5.6} fontSize={3.4} fontFamily="Helvetica, Arial, sans-serif" fontWeight="bold" fill="#111111">
        {clip(tb.projectName, 34)}
      </text>
      <text x={x + 3} y={y + 13} fontSize={3} fontFamily="Helvetica, Arial, sans-serif" fill="#111111">
        {clip(tb.sheetName, 36)}
      </text>
      {tb.author && (
        <text x={x + 3} y={y + 18} fontSize={2.6} fontFamily="Helvetica, Arial, sans-serif" fill="#444444">
          {clip(tb.author, 40)}
        </text>
      )}
      <text x={x + 3} y={y + boxH - 2.4} fontSize={3} fontFamily="Helvetica, Arial, sans-serif" fill="#111111">
        {tb.scale}
      </text>
      <text x={x + boxW - 3} y={y + boxH - 2.4} fontSize={2.6} fontFamily="Helvetica, Arial, sans-serif" fill="#111111" textAnchor="end">
        {tb.date} · {fmt}
      </text>
    </g>
  );
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── In-Viewport-Layout-Ansicht ────────────────────────────────────────────────

export interface LayoutSheetHandlers {
  /** Zurück zur Modell-Ansicht (Grundriss/3D). */
  onBack: () => void;
  /** Ändert Position/Grösse/Massstab eines Viewports (mm). */
  onPatchViewport: (
    viewportId: string,
    patch: Partial<Omit<LayoutViewport, "id" | "snapshotId">>,
  ) => void;
  /** Entfernt einen Viewport per Id. */
  onRemoveViewport: (viewportId: string) => void;
  /** Fügt einen Viewport (gebunden an `snapshotId`) mit gegebener Geometrie an. */
  onAddViewport: (
    snapshotId: string,
    init: Partial<Omit<LayoutViewport, "id" | "snapshotId">>,
  ) => void;
  /**
   * Fügt eine neue Annotation (Linie/Rechteck/Text/Bild) mit gegebener
   * Geometrie an — liefert die neue Id zurück (z. B. um nach dem Aufziehen
   * eines Text-Rahmens sofort inline hineinzuschreiben, s. `inlineEdit`).
   */
  onAddAnnotation: (kind: LayoutAnnotation["kind"], init: LayoutAnnotationPatch) => string;
  /**
   * Ändert Felder einer Annotation (Position/Farbe/Strichstärke/Text).
   * `coalesceKey`: s. `projectSlice.ts` `setProject` — vom Inline-Text-Editor
   * genutzt, damit EIN Tipp-Vorgang EINEN Undo-Schritt erzeugt statt bei
   * jedem Tastendruck einen neuen zu pushen (s. `inlineEdit`-Block unten).
   */
  onPatchAnnotation: (
    annotationId: string,
    patch: LayoutAnnotationPatch,
    coalesceKey?: string,
  ) => void;
  /** Entfernt eine Annotation per Id. */
  onRemoveAnnotation: (annotationId: string) => void;
}

/** Fangzone der Resize-Griffe in Bildschirm-Pixeln (→ mm über den Massstab). */
const HANDLE_TOL_PX = 7;
/** Mindest-Kantenlänge eines Viewports (mm). */
const MIN_VP_MM = 8;
/** Mindest-Kantenlänge eines aufgezogenen Platzierungs-Rechtecks (mm). */
const MIN_PLACE_MM = 6;
/** Mindestgrösse einer neu gezeichneten Linie/eines Rechtecks (mm) — sonst verworfen. */
const MIN_ANNOT_MM = 3;
/** Default-Zeilenhöhe eines neuen Text-Markups (mm). */
const DEFAULT_ANNOT_TEXT_MM = 3.5;
/**
 * CSS-Pixel pro Millimeter bei „echten" 100 % — der CSS-Referenzpixel ist per
 * Spezifikation auf 1/96 Zoll fixiert (96 px = 25.4 mm), UNABHÄNGIG von der
 * physischen Bildschirmauflösung (`devicePixelRatio` gleicht das pro Gerät
 * wieder aus). `SheetTransform.scale` ist „Pixel pro Millimeter" — bei diesem
 * Wert misst ein A4-Blatt (210 mm) auf dem Bildschirm also wirklich 21 cm
 * (Nutzer-Wunsch), nicht nur „passt ins Fenster" wie bei „Einpassen".
 */
const PX_PER_MM_AT_100 = 96 / 25.4;

/** Zeichenwerkzeug für die Annotations-Schicht (zusätzlich zum Viewport-„placing"). */
type AnnotTool = "select" | "line" | "rect" | "text" | "image";

/**
 * Bildet das GLOBALE Werkzeug (linkes Werkzeugpanel, `ToolId`) auf ein
 * `AnnotTool` ab — das Blatt hat keine eigene Werkzeugleiste mehr (Nutzer-
 * Feedback: „ein Layout soll daherkommen wie eine normale Zeichnung, nur dass
 * ein Blatt drin liegt" — dieselben Zeichenwerkzeuge links wie im Grundriss,
 * nichts Eigenes nur fürs Layout). `textbox` zeichnet hier wie `text` (kein
 * eigener Spaltenbreite-Ablauf im Blatt); alle übrigen Werkzeuge (Wand, Fenster,
 * Kreis, …) ergeben auf dem Blatt keinen Sinn → „select".
 */
function annotToolFromGlobal(tool: ToolId): AnnotTool {
  if (tool === "line" || tool === "rect" || tool === "image") return tool;
  if (tool === "text" || tool === "textbox") return "text";
  return "select";
}

type Drag =
  | { mode: "pan"; lastX: number; lastY: number }
  | { mode: "move"; id: string; start: RectMm; grabX: number; grabY: number }
  | { mode: "resize"; id: string; handle: Handle; start: RectMm; grabX: number; grabY: number }
  | { mode: "place"; x0: number; y0: number }
  | { mode: "annot-move"; id: string; start: LayoutAnnotation; grabX: number; grabY: number }
  | {
      mode: "annot-resize";
      id: string;
      hit: AnnotHandleHit;
      start: LayoutAnnotation;
      grabX: number;
      grabY: number;
    }
  | null;

/** Cursor für einen Linien-Endpunkt-Griff (kein direktes `Handle`-Äquivalent). */
function lineHandleCursor(handle: LineHandle): string {
  return handle === "body" ? "move" : "crosshair";
}

/** Annotation abzüglich `id`/`kind` als Patch — für den Commit nach Move/Draw. */
function annotationPatch(a: LayoutAnnotation): LayoutAnnotationPatch {
  const { id: _id, kind: _kind, ...rest } = a as LayoutAnnotation & Record<string, unknown>;
  return rest as LayoutAnnotationPatch;
}

export function LayoutSheetView({
  project,
  layout,
  handlers,
  activeTool,
  onToolChange,
  selectedAnnotId,
  onSelectAnnot,
}: {
  project: Project;
  layout: Layout;
  handlers: LayoutSheetHandlers;
  /** Globales Werkzeug (linkes Werkzeugpanel) — s. `annotToolFromGlobal`. */
  activeTool: ToolId;
  /** Setzt das globale Werkzeug (z. B. zurück auf „select" nach einer Platzierung). */
  onToolChange: (id: ToolId) => void;
  /**
   * Gewählte Annotation — von App.tsx gehoben (statt lokalem State), damit die
   * echte Attribute-Palette (rechtes Panel) dieselbe Auswahl sieht wie ein
   * Drawing2D im Grundriss (Nutzer-Feedback: „Attribute genau wie bei
   * normalen Linien beim Zeichnen").
   */
  selectedAnnotId: string | null;
  onSelectAnnot: (id: string | null) => void;
}) {
  // Alias, damit die bestehenden `setSelectedAnnotId(...)`-Aufrufe unten
  // unverändert bleiben (jetzt ein gehobener Prop-Setter statt lokalem State).
  const setSelectedAnnotId = onSelectAnnot;
  const stageRef = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState({ w: 800, h: 600 });
  const [transform, setTransform] = useState<SheetTransform | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverCursor, setHoverCursor] = useState<string>("default");
  // Werkzeug-Modus „Viewport aufziehen" (armiert). Danach folgt der Ausschnitt-Picker.
  const [placing, setPlacing] = useState(false);
  // Live-Geometrie während eines Move/Resize/Place-Drags (Ghost), sonst null.
  const [previewRect, setPreviewRect] = useState<RectMm | null>(null);
  // Nach dem Aufziehen: das fertige Rechteck (mm) wartet auf die Ausschnitt-Bindung.
  const [pendingRect, setPendingRect] = useState<RectMm | null>(null);
  const [bindSnapId, setBindSnapId] = useState<string>("");
  const dragRef = useRef<Drag>(null);
  const spaceDownRef = useRef(false);

  // ── Annotationen (Linie/Rechteck/Text) — eigenständige Zusatzschicht ────────
  // Werkzeug „select" = normale Auswahl/Verschieben von Viewports+Annotationen;
  // line/rect/text armieren das jeweilige Zeichnen (analog `placing` für Viewports).
  // KEIN eigener Werkzeug-Zustand mehr — armiert wird über das globale Werkzeug
  // (linkes Panel), s. `annotToolFromGlobal`.
  const annotTool = annotToolFromGlobal(activeTool);
  // Ghost-Geometrie: beim Aufziehen einer NEUEN Linie/eines Rechtecks (id="draft")
  // ODER beim Verschieben einer bestehenden Annotation (id = deren echte Id).
  const [annotPreview, setAnnotPreview] = useState<LayoutAnnotation | null>(null);
  // Textwerkzeug: Rahmen aufziehen (Ghost, wie ein Rechteck) — direkt danach
  // öffnet `inlineEdit` den Editor IM Rahmen (kein eigenes Fenster).
  const [textFrameDraft, setTextFrameDraft] = useState<RectMm | null>(null);
  // Erster Klick von Linie/Rechteck/Text: KEIN Ziehen nötig (Nutzer-Feedback —
  // „alle 2D-Werkzeuge sollen sich gleich verhalten wie im Grundriss"), also
  // Klick-Bewegen-Klick wie die Plan-Zeichenwerkzeuge (tools.ts `lineTool`/
  // `rectTool`): erster Klick setzt diesen Punkt, die Maus bewegt den Ghost
  // (`onPointerMove` läuft auch OHNE gehaltene Taste), der zweite Klick
  // schliesst ab. `null` = kein Werkzeug wartet auf den zweiten Klick.
  const [pendingPoint, setPendingPoint] = useState<
    { tool: "line" | "rect" | "text"; xMm: number; yMm: number } | null
  >(null);
  // Wechselt der Nutzer das Werkzeug, während ein erster Klick offen ist (z. B.
  // Escape/anderes Werkzeug im linken Panel), verwirft das den offenen Entwurf.
  useEffect(() => {
    setPendingPoint(null);
    setAnnotPreview((p) => (p?.id === "draft" ? null : p));
    setTextFrameDraft(null);
  }, [annotTool]);
  // Aktuell inline bearbeitete Text-Annotation (neu erstellt ODER per HUD „✎"
  // geöffnet) — `minHeightMm` ist die beim Aufziehen gewählte Rahmenhöhe (rein
  // fürs Editor-Startmass, nicht Teil des Modells — Text wächst mit dem Inhalt).
  const [inlineEdit, setInlineEdit] = useState<{ id: string; minHeightMm: number } | null>(null);
  // Bild-Werkzeug: nach dem Klick wartet die Position auf die Datei-Auswahl
  // (async, s. imageInputRef weiter unten).
  const [imagePendingAt, setImagePendingAt] = useState<{ xMm: number; yMm: number } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const master = findMaster(project, layout);
  // Effektive Grösse respektiert freie Grösse (custom Width/Height) — bindet
  // das Layout an ein Masterlayout, gewinnt dessen Grösse (wie im PDF-Export,
  // `folderPdfPages`: `effectiveSheetSizeMm(master ?? layout)`).
  const sheet = effectiveSheetSizeMm(master ?? layout);
  const titleBlock = resolveTitleBlock(project, layout, master);
  const drawBorder = master ? master.border ?? true : false;
  const snapshots = project.viewSnapshots ?? [];
  const selectedVp = layout.viewports.find((v) => v.id === selectedId) ?? null;
  const annotations = layout.annotations ?? [];
  const selectedAnnot = annotations.find((a) => a.id === selectedAnnotId) ?? null;

  // Verfügbare Fläche messen.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setCanvas({ w: e.contentRect.width, h: e.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Erst-Einpassung, sobald die Fläche gemessen ist (einmal). Bei Blattwechsel
  // (Papier/Ausrichtung) neu einpassen.
  useEffect(() => {
    if (canvas.w <= 0 || canvas.h <= 0) return;
    setTransform((cur) =>
      cur ?? fitTransform(sheet.w, sheet.h, canvas.w, canvas.h),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas.w, canvas.h]);
  useEffect(() => {
    if (canvas.w <= 0 || canvas.h <= 0) return;
    setTransform(fitTransform(sheet.w, sheet.h, canvas.w, canvas.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.w, sheet.h]);

  const fit = () => setTransform(fitTransform(sheet.w, sheet.h, canvas.w, canvas.h));
  const zoomStep = (factor: number) =>
    setTransform((t) => (t ? zoomAtCursor(t, factor, canvas.w / 2, canvas.h / 2) : t));
  // Springt auf echte 1:1-Grösse (s. PX_PER_MM_AT_100), zentriert auf die
  // Canvas-Mitte statt den Cursor (kein aktives Zoom-Gesten-Event hier).
  const zoomTo100 = () =>
    setTransform((t) =>
      t ? zoomAtCursor(t, PX_PER_MM_AT_100 / t.scale, canvas.w / 2, canvas.h / 2) : t,
    );
  const zoomPercent = Math.round(((transform?.scale ?? 0) / PX_PER_MM_AT_100) * 100);

  // Leertaste = Pan-Modifikator (wie in CAD). Delete/Backspace löscht die Auswahl.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;
      if (e.code === "Space") {
        spaceDownRef.current = true;
        e.preventDefault(); // kein Button-Reklick / Seiten-Scroll
        return;
      }
      if (e.key === "Escape") {
        if (placing) {
          setPlacing(false);
          setPreviewRect(null);
        } else if (annotTool !== "select") {
          onToolChange("select");
          setAnnotPreview(null);
          setTextFrameDraft(null);
        } else if (pendingRect) {
          setPendingRect(null);
        } else if (selectedAnnotId) {
          setSelectedAnnotId(null);
        } else {
          setSelectedId(null);
        }
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        handlers.onRemoveViewport(selectedId);
        setSelectedId(null);
        e.preventDefault();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedAnnotId) {
        handlers.onRemoveAnnotation(selectedAnnotId);
        setSelectedAnnotId(null);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDownRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [
    placing,
    pendingRect,
    selectedId,
    selectedAnnotId,
    annotTool,
    handlers,
    onToolChange,
  ]);

  // Bildschirm-Pixel (canvas-lokal) eines Pointer-Events.
  const localXY = (e: { clientX: number; clientY: number }) => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  // Zoom-to-Cursor am Rad: nativer, NICHT-passiver Listener (preventDefault muss
  // greifen — React-onWheel ist passiv). Funktionales setTransform, damit der
  // Listener nur einmal registriert werden muss.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setTransform((t) => (t ? zoomAtCursor(t, factor, x, y) : t));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Schliesst Linie/Rechteck/Text-Rahmen beim ZWEITEN Klick ab (erster Punkt =
  // `pendingPoint`, zweiter = `mm`) — dieselbe Zwei-Klick-Logik, die vorher am
  // `pointerup` einer gehaltenen Ziehgeste hing (s. Git-Historie), jetzt ohne
  // gehaltene Taste nötig.
  const commitTwoPointAnnot = (
    tool: "line" | "rect" | "text",
    p0: { xMm: number; yMm: number },
    p1: { xMm: number; yMm: number },
  ) => {
    if (tool === "line") {
      const len = Math.hypot(p1.xMm - p0.xMm, p1.yMm - p0.yMm);
      if (len >= MIN_ANNOT_MM) {
        handlers.onAddAnnotation("line", {
          x1Mm: round1(p0.xMm),
          y1Mm: round1(p0.yMm),
          x2Mm: round1(p1.xMm),
          y2Mm: round1(p1.yMm),
        });
      }
      return;
    }
    const r = normalizeRect(p0.xMm, p0.yMm, p1.xMm, p1.yMm);
    if (tool === "rect") {
      if (r.widthMm >= MIN_ANNOT_MM && r.heightMm >= MIN_ANNOT_MM) {
        const clamped = clampRectToSheet(r, sheet.w, sheet.h);
        handlers.onAddAnnotation("rect", {
          xMm: round1(clamped.xMm),
          yMm: round1(clamped.yMm),
          widthMm: round1(clamped.widthMm),
          heightMm: round1(clamped.heightMm),
        });
      }
      return;
    }
    // Text: zu klein aufgezogen (praktisch ein Doppelklick auf der Stelle) →
    // Default-Rahmen an der Klickstelle, statt eine Mini-Box zu erzwingen.
    const tooSmall = r.widthMm < MIN_ANNOT_MM || r.heightMm < MIN_ANNOT_MM;
    const widthMm = tooSmall ? 60 : r.widthMm;
    const frameHeightMm = tooSmall ? 20 : r.heightMm;
    const clamped = clampRectToSheet({ xMm: r.xMm, yMm: r.yMm, widthMm, heightMm: frameHeightMm }, sheet.w, sheet.h);
    // `yMm` einer Text-Annotation ist die BASELINE der ersten Zeile (s.
    // `annotationBoundsMm`) — der aufgezogene Rahmen liefert die OBERE Kante,
    // daher + eine Zeilenhöhe (heightMm = Schriftgrösse).
    const id = handlers.onAddAnnotation("text", {
      xMm: round1(clamped.xMm),
      yMm: round1(clamped.yMm + DEFAULT_ANNOT_TEXT_MM),
      widthMm: round1(clamped.widthMm),
      heightMm: DEFAULT_ANNOT_TEXT_MM,
      text: "",
    });
    setSelectedAnnotId(id);
    setInlineEdit({ id, minHeightMm: clamped.heightMm });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!transform) return;
    // Klicks aus dem HUD/Popover (echte Bedienelemente) NICHT als Blatt-Geste werten.
    if ((e.target as HTMLElement).closest("[data-sheet-ui]")) return;
    const { x, y } = localXY(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    // Pan: mittlere Maustaste oder Leertaste-Drag.
    if (e.button === 1 || spaceDownRef.current) {
      dragRef.current = { mode: "pan", lastX: x, lastY: y };
      return;
    }
    if (e.button !== 0) return;

    const mm = screenToMm(transform, x, y);

    // Platzierungs-Modus: Rechteck aufziehen.
    if (placing) {
      dragRef.current = { mode: "place", x0: mm.xMm, y0: mm.yMm };
      setPreviewRect({ xMm: mm.xMm, yMm: mm.yMm, widthMm: 0, heightMm: 0 });
      return;
    }

    // Annotations-Werkzeuge Linie/Rechteck/Text: Klick-Bewegen-Klick wie im
    // Grundriss (kein Ziehen nötig) — erster Klick merkt sich den Punkt
    // (`pendingPoint`), der zweite (hier) schliesst ab. Bild bleibt ein
    // Einzelklick, der sofort den Datei-Dialog öffnet (async, s. imageInputRef).
    if (annotTool === "image") {
      setImagePendingAt({ xMm: mm.xMm, yMm: mm.yMm });
      imageInputRef.current?.click();
      return;
    }
    if (annotTool === "line" || annotTool === "rect" || annotTool === "text") {
      if (pendingPoint && pendingPoint.tool === annotTool) {
        commitTwoPointAnnot(annotTool, pendingPoint, mm);
        setPendingPoint(null);
        setAnnotPreview(null);
        setTextFrameDraft(null);
        // Linie/Rechteck bleiben armiert für die nächste (Plan-Konvention:
        // tools.ts `lineTool`/`rectTool` bleiben nach dem Commit ebenfalls
        // aktiv statt auf „Auswahl" zu springen — mehrere Linien am Stück ohne
        // erneuten Werkzeug-Klick). Text springt zurück auf „Auswahl": direkt
        // danach öffnet der Inline-Editor, ein weiterer Klick soll den Cursor
        // darin setzen, keinen neuen Rahmen aufziehen.
        if (annotTool === "text") onToolChange("select");
        return;
      }
      setPendingPoint({ tool: annotTool, xMm: mm.xMm, yMm: mm.yMm });
      if (annotTool === "line") {
        setAnnotPreview({ id: "draft", kind: "line", x1Mm: mm.xMm, y1Mm: mm.yMm, x2Mm: mm.xMm, y2Mm: mm.yMm });
      } else if (annotTool === "rect") {
        setAnnotPreview({ id: "draft", kind: "rect", xMm: mm.xMm, yMm: mm.yMm, widthMm: 0, heightMm: 0 });
      } else {
        setTextFrameDraft({ xMm: mm.xMm, yMm: mm.yMm, widthMm: 0, heightMm: 0 });
      }
      return;
    }

    const tolMm = HANDLE_TOL_PX / transform.scale;
    const hit = pickViewport(layout.viewports, mm.xMm, mm.yMm, tolMm);
    if (hit) {
      setSelectedId(hit.id);
      setSelectedAnnotId(null);
      const vp = layout.viewports.find((v) => v.id === hit.id)!;
      if (hit.handle === "body") {
        dragRef.current = {
          mode: "move",
          id: hit.id,
          start: vpRect(vp),
          grabX: mm.xMm,
          grabY: mm.yMm,
        };
      } else {
        dragRef.current = {
          mode: "resize",
          id: hit.id,
          handle: hit.handle,
          start: vpRect(vp),
          grabX: mm.xMm,
          grabY: mm.yMm,
        };
      }
      return;
    }

    const annotHit = pickAnnotationHandle(annotations, mm.xMm, mm.yMm, tolMm);
    if (annotHit) {
      setSelectedId(null);
      setSelectedAnnotId(annotHit.id);
      const ann = annotations.find((a) => a.id === annotHit.id)!;
      if (annotHit.hit.handle === "body") {
        dragRef.current = {
          mode: "annot-move",
          id: annotHit.id,
          start: ann,
          grabX: mm.xMm,
          grabY: mm.yMm,
        };
      } else {
        dragRef.current = {
          mode: "annot-resize",
          id: annotHit.id,
          hit: annotHit.hit,
          start: ann,
          grabX: mm.xMm,
          grabY: mm.yMm,
        };
      }
    } else {
      setSelectedId(null);
      setSelectedAnnotId(null);
    }
  };

  // Doppelklick auf ein bestehendes Textfeld öffnet die Bearbeitung wieder —
  // wie InDesign/Affinity (bisher nur über den „✎"-Knopf im HUD erreichbar).
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!transform || annotTool !== "select") return;
    if ((e.target as HTMLElement).closest("[data-sheet-ui]")) return;
    const { x, y } = localXY(e);
    const mm = screenToMm(transform, x, y);
    const tolMm = HANDLE_TOL_PX / transform.scale;
    const hit = pickAnnotationHandle(annotations, mm.xMm, mm.yMm, tolMm);
    if (!hit) return;
    const ann = annotations.find((a) => a.id === hit.id);
    if (!ann || ann.kind !== "text") return;
    setSelectedId(null);
    setSelectedAnnotId(ann.id);
    setInlineEdit({ id: ann.id, minHeightMm: annotationBoundsMm(ann).heightMm });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!transform) return;
    const { x, y } = localXY(e);
    const drag = dragRef.current;

    if (!drag) {
      // Wartet Linie/Rechteck/Text auf den zweiten Klick (`pendingPoint`), folgt
      // der Ghost dem Cursor auch OHNE gehaltene Taste (Klick-Bewegen-Klick wie
      // im Grundriss) — kein Hover-Cursor-Update nötig, das Werkzeug ist eh aktiv.
      if (pendingPoint) {
        const mm = screenToMm(transform, x, y);
        if (pendingPoint.tool === "line") {
          setAnnotPreview({
            id: "draft",
            kind: "line",
            x1Mm: pendingPoint.xMm,
            y1Mm: pendingPoint.yMm,
            x2Mm: mm.xMm,
            y2Mm: mm.yMm,
          });
        } else if (pendingPoint.tool === "rect") {
          const r = normalizeRect(pendingPoint.xMm, pendingPoint.yMm, mm.xMm, mm.yMm);
          setAnnotPreview({ id: "draft", kind: "rect", ...r });
        } else {
          setTextFrameDraft(normalizeRect(pendingPoint.xMm, pendingPoint.yMm, mm.xMm, mm.yMm));
        }
        return;
      }
      // Nur Hover-Cursor aktualisieren (Griffe/Körper), wenn nicht am Ziehen.
      const mm = screenToMm(transform, x, y);
      const tolMm = HANDLE_TOL_PX / transform.scale;
      const hit = pickViewport(layout.viewports, mm.xMm, mm.yMm, tolMm);
      const annotHit = !hit ? pickAnnotationHandle(annotations, mm.xMm, mm.yMm, tolMm) : null;
      setHoverCursor(
        placing || annotTool !== "select"
          ? "crosshair"
          : hit
          ? handleCursor(hit.handle)
          : annotHit
          ? annotHit.hit.kind === "line"
            ? lineHandleCursor(annotHit.hit.handle)
            : handleCursor(annotHit.hit.handle)
          : "default",
      );
      return;
    }

    if (drag.mode === "pan") {
      setTransform((t) => (t ? panBy(t, x - drag.lastX, y - drag.lastY) : t));
      dragRef.current = { ...drag, lastX: x, lastY: y };
      return;
    }

    const mm = screenToMm(transform, x, y);
    if (drag.mode === "place") {
      setPreviewRect(normalizeRect(drag.x0, drag.y0, mm.xMm, mm.yMm));
      return;
    }
    if (drag.mode === "move") {
      const dx = mm.xMm - drag.grabX;
      const dy = mm.yMm - drag.grabY;
      const moved = applyHandleDrag(drag.start, "body", dx, dy, MIN_VP_MM);
      setPreviewRect(clampRectToSheet(moved, sheet.w, sheet.h));
      return;
    }
    if (drag.mode === "resize") {
      const dx = mm.xMm - drag.grabX;
      const dy = mm.yMm - drag.grabY;
      setPreviewRect(applyHandleDrag(drag.start, drag.handle, dx, dy, MIN_VP_MM));
      return;
    }
    if (drag.mode === "annot-move") {
      const dx = mm.xMm - drag.grabX;
      const dy = mm.yMm - drag.grabY;
      setAnnotPreview(translateAnnotation(drag.start, dx, dy));
      return;
    }
    if (drag.mode === "annot-resize") {
      const dx = mm.xMm - drag.grabX;
      const dy = mm.yMm - drag.grabY;
      if (drag.hit.kind === "line") {
        if (drag.start.kind === "line") {
          setAnnotPreview({ ...drag.start, ...applyLineHandleDrag(drag.start, drag.hit.handle, dx, dy) });
        }
      } else if (drag.start.kind === "rect" || drag.start.kind === "image") {
        const r = applyHandleDrag(
          { xMm: drag.start.xMm, yMm: drag.start.yMm, widthMm: drag.start.widthMm, heightMm: drag.start.heightMm },
          drag.hit.handle,
          dx,
          dy,
          MIN_ANNOT_MM,
        );
        setAnnotPreview({ ...drag.start, ...r });
      }
      return;
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.mode === "place") {
      const r = previewRect;
      setPreviewRect(null);
      setPlacing(false);
      if (r && r.widthMm >= MIN_PLACE_MM && r.heightMm >= MIN_PLACE_MM) {
        const clamped = clampRectToSheet(r, sheet.w, sheet.h);
        if (snapshots.length === 1) {
          // Nur ein Ausschnitt → direkt binden.
          handlers.onAddViewport(snapshots[0].id, clamped);
        } else {
          setPendingRect(clamped);
          setBindSnapId("");
        }
      }
      return;
    }

    if ((drag.mode === "move" || drag.mode === "resize") && previewRect) {
      const r = clampRectToSheet(previewRect, sheet.w, sheet.h);
      handlers.onPatchViewport(drag.id, {
        xMm: round1(r.xMm),
        yMm: round1(r.yMm),
        widthMm: round1(Math.max(MIN_VP_MM, r.widthMm)),
        heightMm: round1(Math.max(MIN_VP_MM, r.heightMm)),
      });
    }
    setPreviewRect(null);

    if (drag.mode === "annot-move" || drag.mode === "annot-resize") {
      if (annotPreview) {
        handlers.onPatchAnnotation(drag.id, annotationPatch(annotPreview));
      }
      setAnnotPreview(null);
      return;
    }
  };

  const confirmBind = () => {
    if (bindSnapId && pendingRect) {
      handlers.onAddViewport(bindSnapId, pendingRect);
    }
    setPendingRect(null);
    setBindSnapId("");
  };

  // Blatt-Position (canvas-lokale Pixel) + Grösse.
  const tf = transform ?? fitTransform(sheet.w, sheet.h, canvas.w, canvas.h);
  const paperLeft = tf.tx;
  const paperTop = tf.ty;
  const paperW = sheet.w * tf.scale;
  const paperH = sheet.h * tf.scale;

  // Effektives Rechteck eines Viewports (Ghost während seines Drags).
  const displayRect = (vp: LayoutViewport): RectMm =>
    previewRect &&
    (dragRef.current?.mode === "move" || dragRef.current?.mode === "resize") &&
    dragRef.current?.id === vp.id
      ? previewRect
      : vpRect(vp);

  return (
    <section className="pane layout-sheet-pane">
      {/* Werkzeugleiste (Blatt-Navigation + Platzieren + Zurück). */}
      <div className="layout-sheet-toolbar" data-sheet-ui>
        <button className="nav-add" onClick={handlers.onBack} title={t("layouts.backToModel")}>
          <span className="material-symbols-outlined" aria-hidden="true">chevron_left</span>
          {t("layouts.backToModel")}
        </button>
        <span className="layout-sheet-name">{layout.name}</span>
        <button
          className={`nav-add${placing ? " active" : ""}`}
          onClick={() => {
            setPlacing((v) => !v);
            setPendingRect(null);
            onToolChange("select");
            setAnnotPreview(null);
          }}
          disabled={snapshots.length === 0}
          title={
            snapshots.length === 0 ? t("layouts.noSnapshots") : t("layouts.placeViewport")
          }
        >
          ＋ {t("layouts.placeViewport")}
        </button>
        <span style={{ flex: 1 }} />
        <button className="nav-add" onClick={() => zoomStep(1 / 1.12)} title="−">−</button>
        {/* Zeigt den echten Massstab (100 % = 1:1 auf dem Bildschirm, s.
            PX_PER_MM_AT_100) und setzt ihn per Klick — wie die %-Anzeige in
            Affinity/Figma, nicht nur „Einpassen" (das passt bloss ins Fenster). */}
        <button className="nav-add layout-sheet-zoom-pct" onClick={zoomTo100} title={t("layouts.zoom100")}>
          {zoomPercent}%
        </button>
        <button className="nav-add" onClick={fit} title={t("layouts.fit")}>
          {t("layouts.fit")}
        </button>
        <button className="nav-add" onClick={() => zoomStep(1.12)} title="+">+</button>
      </div>

      {/* Blatt-Tisch: papierartiger Hintergrund, weisses Blatt zentriert. */}
      <div
        ref={stageRef}
        className="layout-sheet-stage"
        style={{ cursor: placing || annotTool !== "select" ? "crosshair" : hoverCursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      >
        {/* Weisses Papier. */}
        <div
          className="layout-sheet-paper"
          style={{ left: paperLeft, top: paperTop, width: paperW, height: paperH }}
        >
          {/* Master: Rahmen + Titelblock (read-only). */}
          <svg
            width={paperW}
            height={paperH}
            viewBox={`0 0 ${sheet.w} ${sheet.h}`}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            {drawBorder && (
              <rect
                x={5}
                y={5}
                width={sheet.w - 10}
                height={sheet.h - 10}
                fill="none"
                stroke="#111111"
                strokeWidth={0.35}
              />
            )}
            {master && (
              <TitleBlockSvg
                sheet={sheet}
                tb={titleBlock}
                paper={layout.paper}
                orientation={layout.orientation}
              />
            )}
          </svg>

          {/* Platzierte Viewports (echter Plan, geklippt). */}
          {layout.viewports.map((vp) => {
            const r = displayRect(vp);
            const snap = findSnapshot(project, vp.snapshotId);
            const selected = vp.id === selectedId;
            return (
              <div
                key={vp.id}
                className={`layout-sheet-vp${selected ? " selected" : ""}`}
                style={{
                  left: r.xMm * tf.scale,
                  top: r.yMm * tf.scale,
                  width: r.widthMm * tf.scale,
                  height: r.heightMm * tf.scale,
                }}
                title={snap ? snap.name : t("layouts.missingSnapshot")}
              >
                {snap ? (
                  <ViewportPlan project={project} viewport={vp} />
                ) : (
                  <div className="layout-sheet-vp-missing">{t("layouts.missingSnapshot")}</div>
                )}
              </div>
            );
          })}

          {/* Annotationen (Linie/Rechteck/Text) — eigene Schicht ÜBER den Viewports,
              in mm über dieselbe viewBox wie Rahmen/Titelblock. Während des
              Zeichnens/Verschiebens ersetzt `annotPreview` die betroffene Annotation
              (Ghost); ein neu gezeichnetes Element (id="draft") ist noch nicht in
              `layout.annotations` und wird zusätzlich gerendert. */}
          <svg
            width={paperW}
            height={paperH}
            viewBox={`0 0 ${sheet.w} ${sheet.h}`}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            {annotations.map((ann) => {
              // Während des Inline-Editors NICHT zusätzlich statisch zeichnen
              // (nur bei Text-Annotationen möglich, s. `inlineEdit`-Block
              // unten) — sonst blieben Reste des alten Umbruchs sichtbar,
              // weil das SVG nach geschätzter Zeichenbreite umbricht, der
              // Editor-Browser aber nach echter Font-Metrik (leicht andere
              // Zeilenumbrüche, Editor-Weiss deckt nicht jede Abweichung).
              if (ann.id === inlineEdit?.id) return null;
              const a = annotPreview && annotPreview.id === ann.id ? annotPreview : ann;
              return <AnnotationSvg key={ann.id} ann={a} selected={ann.id === selectedAnnotId} />;
            })}
            {annotPreview && annotPreview.id === "draft" && (
              <AnnotationSvg ann={annotPreview} ghost />
            )}
            {/* Gestrichelter Auswahl-Rahmen um die gewählte Annotation. */}
            {selectedAnnot &&
              (() => {
                const display =
                  annotPreview && annotPreview.id === selectedAnnot.id
                    ? annotPreview
                    : selectedAnnot;
                const b = annotationBoundsMm(display);
                return (
                  <rect
                    x={b.xMm - 1.5}
                    y={b.yMm - 1.5}
                    width={b.widthMm + 3}
                    height={b.heightMm + 3}
                    fill="none"
                    stroke="#2478ff"
                    strokeWidth={0.3}
                    strokeDasharray="1.5 1.5"
                  />
                );
              })()}
          </svg>

          {/* Auswahl-Griffe des gewählten Viewports. */}
          {selectedVp &&
            handleAnchors(displayRect(selectedVp)).map((a) => (
              <div
                key={a.handle}
                className="layout-sheet-grip"
                style={{
                  left: a.xMm * tf.scale,
                  top: a.yMm * tf.scale,
                  cursor: handleCursor(a.handle),
                }}
              />
            ))}

          {/* Auswahl-Griffe der gewählten Annotation — Rechteck/Bild wie ein
              Viewport (8 Ecken/Kanten), Linie mit ihren zwei Endpunkten (wie im
              Grundriss). Text hat (noch) keine Griffe. */}
          {selectedAnnot &&
            (() => {
              const display =
                annotPreview && annotPreview.id === selectedAnnot.id ? annotPreview : selectedAnnot;
              if (display.kind === "rect" || display.kind === "image") {
                return handleAnchors({
                  xMm: display.xMm,
                  yMm: display.yMm,
                  widthMm: display.widthMm,
                  heightMm: display.heightMm,
                }).map((a) => (
                  <div
                    key={a.handle}
                    className="layout-sheet-grip"
                    style={{ left: a.xMm * tf.scale, top: a.yMm * tf.scale, cursor: handleCursor(a.handle) }}
                  />
                ));
              }
              if (display.kind === "line") {
                return lineHandleAnchors(display).map((p, i) => (
                  <div
                    key={i}
                    className="layout-sheet-grip"
                    style={{ left: p.xMm * tf.scale, top: p.yMm * tf.scale, cursor: "crosshair" }}
                  />
                ));
              }
              return null;
            })()}

          {/* Ghost-Rechteck beim Aufziehen (Platzieren). */}
          {previewRect && dragRef.current?.mode === "place" && (
            <div
              className="layout-sheet-ghost"
              style={{
                left: previewRect.xMm * tf.scale,
                top: previewRect.yMm * tf.scale,
                width: previewRect.widthMm * tf.scale,
                height: previewRect.heightMm * tf.scale,
              }}
            />
          )}

          {/* Ghost-Rahmen beim Aufziehen eines neuen Textfelds. */}
          {textFrameDraft && (
            <div
              className="layout-sheet-ghost"
              style={{
                left: textFrameDraft.xMm * tf.scale,
                top: textFrameDraft.yMm * tf.scale,
                width: textFrameDraft.widthMm * tf.scale,
                height: textFrameDraft.heightMm * tf.scale,
              }}
            />
          )}
        </div>

        {/* HUD: Eigenschaften des gewählten Viewports (Massstab/Grösse/Löschen). */}
        {selectedVp && (
          <div className="layout-sheet-hud" data-sheet-ui>
            <div className="layout-sheet-hud-title">
              {findSnapshot(project, selectedVp.snapshotId)?.name ??
                t("layouts.missingSnapshot")}
            </div>
            <label className="layout-sheet-hud-row">
              <span>{t("layouts.scale")}</span>
              <span className="layout-sheet-hud-scale">
                1:
                <input
                  type="number"
                  className="res-input mono num"
                  min={1}
                  step={1}
                  value={resolveViewportScale(
                    selectedVp,
                    findSnapshot(project, selectedVp.snapshotId),
                  )}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isFinite(v) && v > 0)
                      handlers.onPatchViewport(selectedVp.id, { scaleDenominator: v });
                  }}
                />
              </span>
            </label>
            <div className="layout-sheet-hud-size">
              {Math.round(selectedVp.widthMm)} × {Math.round(selectedVp.heightMm)} mm
            </div>
            <div className="layout-sheet-hud-actions">
              {selectedVp.scaleDenominator !== undefined && (
                <button
                  className="nav-add"
                  onClick={() =>
                    handlers.onPatchViewport(selectedVp.id, { scaleDenominator: undefined })
                  }
                  title={t("layouts.scaleReset")}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">restart_alt</span>
                </button>
              )}
              <button
                className="nav-add"
                onClick={() => {
                  handlers.onRemoveViewport(selectedVp.id);
                  setSelectedId(null);
                }}
                title={t("layouts.removeViewport")}
              >
                <span className="material-symbols-outlined" aria-hidden="true">delete</span>
              </button>
            </div>
          </div>
        )}

        {/* HUD: Eigenschaften der gewählten Annotation (Farbe/Strichstärke/Text/
            Bild-Grösse/Löschen — je nach Art). */}
        {selectedAnnot && (
          <div className="layout-sheet-hud" data-sheet-ui>
            <div className="layout-sheet-hud-title">{t(`layouts.annot.${selectedAnnot.kind}`)}</div>
            {/* Position (mm, Blattkoordinaten oben-links) — für ALLE Arten über
                dieselbe Bbox-Ableitung wie die Griffe (`annotationBoundsMm`);
                der Commit verschiebt die ganze Annotation um das Delta
                (`translateAnnotation`, dieselbe Funktion wie beim Ziehen).
                Das ist der eigentliche Ort für X/Y einer Blatt-Annotation
                (Papier-Millimeter) — NICHT das Objekt-Info-Panel (Modell-Meter,
                zeigt für Layout-Markups bewusst „nicht anwendbar" statt 0/0). */}
            {(() => {
              const b = annotationBoundsMm(selectedAnnot);
              const moveTo = (nxMm: number, nyMm: number) => {
                const moved = translateAnnotation(selectedAnnot, nxMm - b.xMm, nyMm - b.yMm);
                handlers.onPatchAnnotation(selectedAnnot.id, annotationPatch(moved));
              };
              return (
                <>
                  <label className="layout-sheet-hud-row">
                    <span>{t("layouts.annotX")}</span>
                    <input
                      type="number"
                      className="res-input mono num"
                      step={1}
                      value={Math.round(b.xMm)}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (Number.isFinite(v)) moveTo(v, b.yMm);
                      }}
                    />
                  </label>
                  <label className="layout-sheet-hud-row">
                    <span>{t("layouts.annotY")}</span>
                    <input
                      type="number"
                      className="res-input mono num"
                      step={1}
                      value={Math.round(b.yMm)}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (Number.isFinite(v)) moveTo(b.xMm, v);
                      }}
                    />
                  </label>
                </>
              );
            })()}
            {/* Farbe/Strichstärke stehen jetzt in der echten Attribute-Palette
                (dieselbe wie bei einer Linie im Grundriss, Nutzer-Feedback) —
                hier nur noch Position + Grösse (Bild) + Aktionen, keine Dopplung. */}
            {selectedAnnot.kind === "text" && (
              <div className="layout-sheet-hud-size">{clip(selectedAnnot.text, 40)}</div>
            )}
            {selectedAnnot.kind === "image" && (
              <>
                <label className="layout-sheet-hud-row">
                  <span>{t("layouts.annotWidth")}</span>
                  <input
                    type="number"
                    className="res-input mono num"
                    min={2}
                    step={1}
                    value={Math.round(selectedAnnot.widthMm)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v) && v > 0)
                        handlers.onPatchAnnotation(selectedAnnot.id, { widthMm: v });
                    }}
                  />
                </label>
                <label className="layout-sheet-hud-row">
                  <span>{t("layouts.annotHeight")}</span>
                  <input
                    type="number"
                    className="res-input mono num"
                    min={2}
                    step={1}
                    value={Math.round(selectedAnnot.heightMm)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v) && v > 0)
                        handlers.onPatchAnnotation(selectedAnnot.id, { heightMm: v });
                    }}
                  />
                </label>
              </>
            )}
            <div className="layout-sheet-hud-actions">
              {selectedAnnot.kind === "text" && (
                <button
                  className="nav-add"
                  onClick={() =>
                    setInlineEdit({
                      id: selectedAnnot.id,
                      minHeightMm: annotationBoundsMm(selectedAnnot).heightMm,
                    })
                  }
                  title={t("layouts.annotEditText")}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">edit</span>
                </button>
              )}
              <button
                className="nav-add"
                onClick={() => {
                  handlers.onRemoveAnnotation(selectedAnnot.id);
                  setSelectedAnnotId(null);
                }}
                title={t("layouts.annotRemove")}
              >
                <span className="material-symbols-outlined" aria-hidden="true">delete</span>
              </button>
            </div>
          </div>
        )}

        {/* Ausschnitt-Bindung nach dem Aufziehen (Inline-Dropdown, kein prompt). */}
        {pendingRect && (
          <div className="layout-sheet-bind" data-sheet-ui>
            <div className="layout-sheet-hud-title">{t("layouts.bindSnapshot")}</div>
            <div style={{ display: "flex", gap: 5 }}>
              <select
                className="res-select"
                style={{ flex: 1 }}
                value={bindSnapId}
                autoFocus
                onChange={(e) => setBindSnapId(e.target.value)}
              >
                <option value="">{t("layouts.pickSnapshot")}</option>
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button className="nav-add" disabled={!bindSnapId} onClick={confirmBind}>
                <span className="material-symbols-outlined" aria-hidden="true">check</span>
              </button>
              <button className="nav-add" onClick={() => setPendingRect(null)}>
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
          </div>
        )}

        {/* Leer-Hinweis (keine Ausschnitte / keine Viewports). */}
        {layout.viewports.length === 0 &&
          annotations.length === 0 &&
          !previewRect &&
          !pendingRect && (
            <div className="layout-sheet-empty" data-sheet-ui>
              {snapshots.length === 0
                ? t("layouts.noSnapshots")
                : placing
                ? t("layouts.placeHint")
                : t("layouts.emptyViewports")}
            </div>
          )}
      </div>

      {/* Inline-Text-Editor DIREKT im Rahmen auf dem Blatt (kein eigenes Fenster,
          Nutzer-Feedback) — für eine neu aufgezogene Text-Annotation (sofort
          nach dem Aufziehen) ODER eine per HUD „✎" geöffnete bestehende. Jede
          Änderung schreibt sofort zurück (`onPatchAnnotation`); ein Klick
          daneben (Backdrop) oder Escape schliesst nur, es gibt nichts zu
          verwerfen. WYSIWYG: Schriftgrösse UND Feldhöhe folgen dem echten
          Blatt-Zoom über die CSS-Variablen `--rt-font-size`/`--rt-min-height`
          (identisches Muster wie PlanView.tsx, s. dort) — NUR die Textfläche
          skaliert, NICHT die Toolbar. Vorher lief das über ein
          `transform:scale()` auf die GANZE Box (inkl. Toolbar, die dadurch
          beim Reinzoomen riesig/unbedienbar wurde) UND `RichTextEditor`
          schrieb pro Run trotzdem eine ABSOLUTE `pt`-Grösse (per Inline-
          `style` auf jedem `<span>`), die die geerbte Container-Grösse
          ignoriert hätte, ohne den Transform-Umweg — beides zusammen war der
          Bug hinter "Editor ist immer unterschiedlich gross wie der Text".
          `sizeUnit="em"` auf `RichTextEditor` lässt Runs jetzt relativ zur
          geerbten Grösse skalieren, s. `text/renderHtml.ts`. ZUSÄTZLICHER
          Positions-Fix (Folgemeldung "Editor ist tiefer als der Text"): die
          Toolbar stand bisher im normalen Fluss ÜBER der Textfläche und
          schob sie um ihre eigene, zoomunabhängige Höhe nach unten — bei
          üblichem Zoom mehr als die EINE Zeilenhöhe Versatz, mit der die
          Box positioniert wird. `.rt-toolbar` schwebt jetzt per CSS
          (`position:absolute; bottom:100%`, s. styles.css) OBERHALB der
          Fläche, ausserhalb von deren Layout-Fluss. */}
      {inlineEdit &&
        (() => {
          const ann = annotations.find((a) => a.id === inlineEdit.id);
          if (!ann || ann.kind !== "text") return null;
          const doc = ann.doc ?? docFromText(ann.text);
          const widthMm = ann.widthMm ?? 60;
          const contentHeightMm = annotationBoundsMm(ann).heightMm;
          const heightMm = Math.max(inlineEdit.minHeightMm, contentHeightMm);
          const fontSizePx = Math.max(9, ann.heightMm * tf.scale);
          const widthPx = widthMm * tf.scale;
          const minHeightPx = heightMm * tf.scale;
          // Baseline → Box-Oberkante: echtes Font-Measuring statt der groben
          // "ganzes heightMm"-Näherung (s. PlanView.tsx, identischer Fix).
          const baselineFromTop = contentFontBaselineFromTop(TEXT_LINE_HEIGHT_MULT);
          const screen = mmToScreen(tf, {
            xMm: ann.xMm,
            yMm: ann.yMm - ann.heightMm * baselineFromTop,
          });
          const cssVars = {
            "--rt-font-size": `${fontSizePx}px`,
            "--rt-min-height": `${minHeightPx}px`,
          } as CSSProperties;
          const commit = (edited: typeof doc) =>
            handlers.onPatchAnnotation(
              ann.id,
              {
                doc: edited,
                text: edited.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n"),
              },
              `layoutAnnotationText:${ann.id}`,
            );
          return (
            <>
              <div
                className="layout-sheet-inline-backdrop"
                data-sheet-ui
                onPointerDown={() => setInlineEdit(null)}
              />
              <div
                className="layout-sheet-inline-text"
                data-sheet-ui
                style={{
                  left: screen.x,
                  top: screen.y,
                  width: widthPx,
                  ...cssVars,
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setInlineEdit(null);
                  }
                }}
              >
                <RichTextEditor value={doc} onChange={commit} autoFocus sizeUnit="em" />
              </div>
            </>
          );
        })()}

      {/* Verstecktes Bild/PDF-Datei-Input (Werkzeug „image"). */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*,.pdf,application/pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          onToolChange("select");
          const at = imagePendingAt;
          setImagePendingAt(null);
          if (!f || !at) return;
          const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
          if (isPdf) {
            void rasterizePdfPages(f).then((pages) => {
              pages.forEach((pg, i) => {
                const { widthMm, heightMm } = defaultImageSizeMm(pg.naturalWidth, pg.naturalHeight);
                const cascade = i * 6;
                handlers.onAddAnnotation("image", {
                  xMm: at.xMm - widthMm / 2 + cascade,
                  yMm: at.yMm - heightMm / 2 + cascade,
                  widthMm,
                  heightMm,
                  src: pg.src,
                });
              });
            });
          } else {
            void readImageFile(f).then(({ src, naturalWidth, naturalHeight }) => {
              const { widthMm, heightMm } = defaultImageSizeMm(naturalWidth, naturalHeight);
              handlers.onAddAnnotation("image", {
                xMm: at.xMm - widthMm / 2,
                yMm: at.yMm - heightMm / 2,
                widthMm,
                heightMm,
                src,
              });
            });
          }
        }}
      />
    </section>
  );
}

/**
 * Rendert EINE Annotation im mm-viewBox: Linie/Rechteck als Umriss (Default
 * `#111111`/0.25 mm, überschreibbar), Text als Baseline-`<text>` mit
 * `font-size = heightMm`. Ausgewählte Annotationen werden blau eingefärbt;
 * `ghost` (Zeichnen-Vorschau) wird gestrichelt + halbtransparent dargestellt.
 */
function AnnotationSvg({
  ann,
  selected,
  ghost,
}: {
  ann: LayoutAnnotation;
  selected?: boolean;
  ghost?: boolean;
}) {
  const selectedColor = "#2478ff";
  const dash = ghost ? "2 1.5" : undefined;
  const opacity = ghost ? 0.7 : 1;
  if (ann.kind === "line") {
    return (
      <line
        x1={ann.x1Mm}
        y1={ann.y1Mm}
        x2={ann.x2Mm}
        y2={ann.y2Mm}
        stroke={selected ? selectedColor : ann.color ?? "#111111"}
        strokeWidth={selected ? Math.max(ann.weightMm ?? 0.25, 0.4) : ann.weightMm ?? 0.25}
        strokeDasharray={dash}
        opacity={opacity}
      />
    );
  }
  if (ann.kind === "rect") {
    return (
      <rect
        x={ann.xMm}
        y={ann.yMm}
        width={ann.widthMm}
        height={ann.heightMm}
        fill="none"
        stroke={selected ? selectedColor : ann.color ?? "#111111"}
        strokeWidth={selected ? Math.max(ann.weightMm ?? 0.25, 0.4) : ann.weightMm ?? 0.25}
        strokeDasharray={dash}
        opacity={opacity}
      />
    );
  }
  if (ann.kind === "image") {
    return (
      <image
        href={ann.src}
        x={ann.xMm}
        y={ann.yMm}
        width={ann.widthMm}
        height={ann.heightMm}
        opacity={(ann.opacity ?? 1) * opacity}
        preserveAspectRatio="none"
      />
    );
  }
  // Text: reiches Doc (mehrere Absätze/gemischte Formatierung) hat Vorrang vor
  // dem einfachen String — bricht bei gesetzter Rahmenbreite (`widthMm`)
  // wortweise um (Run-Grenzen bleiben erhalten, s. `wrapDocToLines`).
  if (ann.doc) {
    const lineHeight = ann.heightMm * 1.25;
    const lines: SvgLine[] = wrapDocToLines(ann.doc, {
      x: 0,
      y: 0,
      lineHeight,
      unitPerPt: 25.4 / 72,
      basePt: (ann.heightMm / 25.4) * 72,
      color: ann.color ?? "#111111",
      ...(ann.widthMm && ann.widthMm > 0 ? { wrapWidthUnits: ann.widthMm } : {}),
    });
    let y = ann.yMm;
    return (
      <text opacity={opacity}>
        {lines.map((line, k) => {
          if (k > 0) y += line.lineHeight;
          const anchor = line.align === "center" ? "middle" : line.align === "right" ? "end" : "start";
          const x =
            !ann.widthMm ? ann.xMm
              : line.align === "center" ? ann.xMm + ann.widthMm / 2
              : line.align === "right" ? ann.xMm + ann.widthMm
              : ann.xMm;
          return (
            <tspan key={k} x={x} y={y} textAnchor={anchor}>
              {line.tspans.length === 0
                ? "​"
                : line.tspans.map((ts, j) => (
                    <tspan
                      key={j}
                      fontSize={ts.fontSize}
                      fontWeight={ts.fontWeight}
                      fontStyle={ts.fontStyle}
                      fontFamily={ts.fontFamily ?? "Helvetica, Arial, sans-serif"}
                      fill={selected ? selectedColor : ts.fill}
                      textDecoration={ts.textDecoration}
                    >
                      {ts.text}
                    </tspan>
                  ))}
            </tspan>
          );
        })}
      </text>
    );
  }
  return (
    <text
      x={ann.xMm}
      y={ann.yMm}
      fontSize={ann.heightMm}
      fontFamily="Helvetica, Arial, sans-serif"
      fill={selected ? selectedColor : ann.color ?? "#111111"}
      opacity={opacity}
    >
      {ann.text}
    </text>
  );
}

/** Auf 0.1 mm runden (weniger Rausch-Nachkommastellen beim Commit). */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

