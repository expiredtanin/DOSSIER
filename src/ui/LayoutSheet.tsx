// Layout-Blatt als erstklassige Ansicht im HAUPT-Viewport (Phase 2b) — das Blatt
// liegt auf einem dunklen „Tisch", ist pan-/zoombar (Zoom-to-Cursor) und die
// platzierten Viewports lassen sich mit der Maus platzieren/verschieben/skalieren/
// löschen (wie ArchiCAD/Vectorworks). Der Render-Kern (echter Plan je Viewport,
// Master-Titelblock) lebt hier zentral (ViewportPlan, TitleBlockSvg unten) und
// ersetzt das frühere schwebende Layout-Fenster (Phase 2a).
//
// Geometrie/Transform/Trefferlogik liegen rein + testbar in layoutSheetMath.ts.
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
  clampRectToSheet,
  fitTransform,
  handleAnchors,
  handleCursor,
  normalizeRect,
  panBy,
  pickAnnotation,
  pickViewport,
  screenToMm,
  translateAnnotation,
  vpRect,
  zoomAtCursor,
  type Handle,
  type RectMm,
  type SheetTransform,
} from "./layoutSheetMath";
import { PromptDialog } from "./PromptDialog";
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
      const plan = generatePlan(
        project,
        snap.activeLevelId,
        codes,
        undefined,
        snap.detail,
        false,
        false,
      );
      const scaleN = resolveViewportScale(viewport, snap);
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
  /** Fügt eine neue Annotation (Linie/Rechteck/Text) mit gegebener Geometrie an. */
  onAddAnnotation: (kind: LayoutAnnotation["kind"], init: LayoutAnnotationPatch) => void;
  /** Ändert Felder einer Annotation (Position/Farbe/Strichstärke/Text). */
  onPatchAnnotation: (annotationId: string, patch: LayoutAnnotationPatch) => void;
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

/** Zeichenwerkzeug für die Annotations-Schicht (zusätzlich zum Viewport-„placing"). */
type AnnotTool = "select" | "line" | "rect" | "text";

type Drag =
  | { mode: "pan"; lastX: number; lastY: number }
  | { mode: "move"; id: string; start: RectMm; grabX: number; grabY: number }
  | { mode: "resize"; id: string; handle: Handle; start: RectMm; grabX: number; grabY: number }
  | { mode: "place"; x0: number; y0: number }
  | { mode: "annot-line"; x0: number; y0: number }
  | { mode: "annot-rect"; x0: number; y0: number }
  | { mode: "annot-move"; id: string; start: LayoutAnnotation; grabX: number; grabY: number }
  | null;

/** Annotation abzüglich `id`/`kind` als Patch — für den Commit nach Move/Draw. */
function annotationPatch(a: LayoutAnnotation): LayoutAnnotationPatch {
  const { id: _id, kind: _kind, ...rest } = a as LayoutAnnotation & Record<string, unknown>;
  return rest as LayoutAnnotationPatch;
}

export function LayoutSheetView({
  project,
  layout,
  handlers,
}: {
  project: Project;
  layout: Layout;
  handlers: LayoutSheetHandlers;
}) {
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
  const [annotTool, setAnnotTool] = useState<AnnotTool>("select");
  const [selectedAnnotId, setSelectedAnnotId] = useState<string | null>(null);
  // Ghost-Geometrie: beim Aufziehen einer NEUEN Linie/eines Rechtecks (id="draft")
  // ODER beim Verschieben einer bestehenden Annotation (id = deren echte Id).
  const [annotPreview, setAnnotPreview] = useState<LayoutAnnotation | null>(null);
  // Textwerkzeug: nach dem Klick wartet die Position auf den PromptDialog-Text.
  const [textPendingAt, setTextPendingAt] = useState<{ xMm: number; yMm: number } | null>(null);
  // HUD „Text ändern" — öffnet den PromptDialog mit dem aktuellen Inhalt.
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

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
          setAnnotTool("select");
          setAnnotPreview(null);
        } else if (pendingRect) {
          setPendingRect(null);
        } else if (textPendingAt) {
          setTextPendingAt(null);
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
    textPendingAt,
    handlers,
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

    // Annotations-Werkzeuge: Linie/Rechteck aufziehen, Text sofort per Dialog.
    if (annotTool === "text") {
      setTextPendingAt({ xMm: mm.xMm, yMm: mm.yMm });
      return;
    }
    if (annotTool === "line") {
      dragRef.current = { mode: "annot-line", x0: mm.xMm, y0: mm.yMm };
      setAnnotPreview({
        id: "draft",
        kind: "line",
        x1Mm: mm.xMm,
        y1Mm: mm.yMm,
        x2Mm: mm.xMm,
        y2Mm: mm.yMm,
      });
      return;
    }
    if (annotTool === "rect") {
      dragRef.current = { mode: "annot-rect", x0: mm.xMm, y0: mm.yMm };
      setAnnotPreview({ id: "draft", kind: "rect", xMm: mm.xMm, yMm: mm.yMm, widthMm: 0, heightMm: 0 });
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

    const annotId = pickAnnotation(annotations, mm.xMm, mm.yMm, tolMm);
    if (annotId) {
      setSelectedId(null);
      setSelectedAnnotId(annotId);
      const ann = annotations.find((a) => a.id === annotId)!;
      dragRef.current = { mode: "annot-move", id: annotId, start: ann, grabX: mm.xMm, grabY: mm.yMm };
    } else {
      setSelectedId(null);
      setSelectedAnnotId(null);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!transform) return;
    const { x, y } = localXY(e);
    const drag = dragRef.current;

    if (!drag) {
      // Nur Hover-Cursor aktualisieren (Griffe/Körper), wenn nicht am Ziehen.
      const mm = screenToMm(transform, x, y);
      const tolMm = HANDLE_TOL_PX / transform.scale;
      const hit = pickViewport(layout.viewports, mm.xMm, mm.yMm, tolMm);
      const annotHit = !hit ? pickAnnotation(annotations, mm.xMm, mm.yMm, tolMm) : null;
      setHoverCursor(
        placing || annotTool !== "select"
          ? "crosshair"
          : hit
          ? handleCursor(hit.handle)
          : annotHit
          ? "move"
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
    if (drag.mode === "annot-line") {
      setAnnotPreview({ id: "draft", kind: "line", x1Mm: drag.x0, y1Mm: drag.y0, x2Mm: mm.xMm, y2Mm: mm.yMm });
      return;
    }
    if (drag.mode === "annot-rect") {
      const r = normalizeRect(drag.x0, drag.y0, mm.xMm, mm.yMm);
      setAnnotPreview({ id: "draft", kind: "rect", ...r });
      return;
    }
    if (drag.mode === "annot-move") {
      const dx = mm.xMm - drag.grabX;
      const dy = mm.yMm - drag.grabY;
      setAnnotPreview(translateAnnotation(drag.start, dx, dy));
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

    if (drag.mode === "annot-line") {
      const p = annotPreview;
      setAnnotPreview(null);
      setAnnotTool("select");
      if (p && p.kind === "line") {
        const len = Math.hypot(p.x2Mm - p.x1Mm, p.y2Mm - p.y1Mm);
        if (len >= MIN_ANNOT_MM) {
          handlers.onAddAnnotation("line", {
            x1Mm: round1(p.x1Mm),
            y1Mm: round1(p.y1Mm),
            x2Mm: round1(p.x2Mm),
            y2Mm: round1(p.y2Mm),
          });
        }
      }
      return;
    }
    if (drag.mode === "annot-rect") {
      const p = annotPreview;
      setAnnotPreview(null);
      setAnnotTool("select");
      if (p && p.kind === "rect" && p.widthMm >= MIN_ANNOT_MM && p.heightMm >= MIN_ANNOT_MM) {
        const clamped = clampRectToSheet(
          { xMm: p.xMm, yMm: p.yMm, widthMm: p.widthMm, heightMm: p.heightMm },
          sheet.w,
          sheet.h,
        );
        handlers.onAddAnnotation("rect", {
          xMm: round1(clamped.xMm),
          yMm: round1(clamped.yMm),
          widthMm: round1(clamped.widthMm),
          heightMm: round1(clamped.heightMm),
        });
      }
      return;
    }
    if (drag.mode === "annot-move") {
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
          ‹ {t("layouts.backToModel")}
        </button>
        <span className="layout-sheet-name">{layout.name}</span>
        <button
          className={`nav-add${placing ? " active" : ""}`}
          onClick={() => {
            setPlacing((v) => !v);
            setPendingRect(null);
            setAnnotTool("select");
            setAnnotPreview(null);
          }}
          disabled={snapshots.length === 0}
          title={
            snapshots.length === 0 ? t("layouts.noSnapshots") : t("layouts.placeViewport")
          }
        >
          ＋ {t("layouts.placeViewport")}
        </button>
        <span className="layout-sheet-toolbar-sep" />
        <button
          className={`nav-add${annotTool === "line" ? " active" : ""}`}
          onClick={() => {
            setAnnotTool((v) => (v === "line" ? "select" : "line"));
            setAnnotPreview(null);
            setPlacing(false);
            setPreviewRect(null);
          }}
          title={t("layouts.annotLine")}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <line x1="2" y1="12" x2="12" y2="2" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
        <button
          className={`nav-add${annotTool === "rect" ? " active" : ""}`}
          onClick={() => {
            setAnnotTool((v) => (v === "rect" ? "select" : "rect"));
            setAnnotPreview(null);
            setPlacing(false);
            setPreviewRect(null);
          }}
          title={t("layouts.annotRect")}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <rect x="2" y="3" width="10" height="8" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
        <button
          className={`nav-add${annotTool === "text" ? " active" : ""}`}
          onClick={() => {
            setAnnotTool((v) => (v === "text" ? "select" : "text"));
            setAnnotPreview(null);
            setPlacing(false);
            setPreviewRect(null);
          }}
          title={t("layouts.annotText")}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <text x="2" y="11" fontSize="10" fontFamily="Helvetica, Arial, sans-serif" fill="currentColor">
              T
            </text>
          </svg>
        </button>
        <span style={{ flex: 1 }} />
        <button className="nav-add" onClick={() => zoomStep(1 / 1.12)} title="−">−</button>
        <button className="nav-add" onClick={fit} title={t("layouts.fit")}>
          {t("layouts.fit")}
        </button>
        <button className="nav-add" onClick={() => zoomStep(1.12)} title="+">+</button>
      </div>

      {/* Blatt-Tisch: dunkler Hintergrund, weisses Blatt zentriert. */}
      <div
        ref={stageRef}
        className="layout-sheet-stage"
        style={{ cursor: placing || annotTool !== "select" ? "crosshair" : hoverCursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
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
                  ↺
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
                🗑
              </button>
            </div>
          </div>
        )}

        {/* HUD: Eigenschaften der gewählten Annotation (Farbe/Strichstärke/Text/Löschen). */}
        {selectedAnnot && (
          <div className="layout-sheet-hud" data-sheet-ui>
            <div className="layout-sheet-hud-title">{t(`layouts.annot.${selectedAnnot.kind}`)}</div>
            <label className="layout-sheet-hud-row">
              <span>{t("layouts.annotColor")}</span>
              <input
                type="color"
                value={selectedAnnot.color ?? "#111111"}
                onChange={(e) =>
                  handlers.onPatchAnnotation(selectedAnnot.id, { color: e.target.value })
                }
              />
            </label>
            {selectedAnnot.kind !== "text" && (
              <label className="layout-sheet-hud-row">
                <span>{t("layouts.annotWeight")}</span>
                <input
                  type="number"
                  className="res-input mono num"
                  min={0.05}
                  step={0.05}
                  value={selectedAnnot.weightMm ?? 0.25}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v > 0)
                      handlers.onPatchAnnotation(selectedAnnot.id, { weightMm: v });
                  }}
                />
              </label>
            )}
            {selectedAnnot.kind === "text" && (
              <div className="layout-sheet-hud-size">{clip(selectedAnnot.text, 40)}</div>
            )}
            <div className="layout-sheet-hud-actions">
              {selectedAnnot.kind === "text" && (
                <button
                  className="nav-add"
                  onClick={() => setEditingTextId(selectedAnnot.id)}
                  title={t("layouts.annotEditText")}
                >
                  ✎
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
                🗑
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
                ✓
              </button>
              <button className="nav-add" onClick={() => setPendingRect(null)}>
                ×
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

      {/* Textwerkzeug: Position gesetzt, Inhalt kommt per Dialog (kein window.prompt). */}
      {textPendingAt && (
        <PromptDialog
          title={t("layouts.annotTextTitle")}
          label={t("layouts.annotTextLabel")}
          onConfirm={(value) => {
            handlers.onAddAnnotation("text", {
              xMm: round1(textPendingAt.xMm),
              yMm: round1(textPendingAt.yMm),
              text: value,
              heightMm: DEFAULT_ANNOT_TEXT_MM,
            });
            setTextPendingAt(null);
            setAnnotTool("select");
          }}
          onClose={() => {
            setTextPendingAt(null);
            setAnnotTool("select");
          }}
        />
      )}

      {/* HUD „Text ändern" für eine ausgewählte Text-Annotation. */}
      {editingTextId &&
        (() => {
          const ann = annotations.find((a) => a.id === editingTextId);
          if (!ann || ann.kind !== "text") return null;
          return (
            <PromptDialog
              title={t("layouts.annotTextTitle")}
              label={t("layouts.annotTextLabel")}
              defaultValue={ann.text}
              onConfirm={(value) => {
                handlers.onPatchAnnotation(editingTextId, { text: value });
                setEditingTextId(null);
              }}
              onClose={() => setEditingTextId(null)}
            />
          );
        })()}
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

