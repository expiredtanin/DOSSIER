// Layout-Blatt im Haupt-Viewport. Das Blatt ist KEINE eigene Zeichenfläche mehr: gezeichnet wird in
// der gewöhnlichen Plan-Ansicht (PlanView) auf der Blatt-Ebene des Layouts (`DrawingLevel.layoutId`,
// Papier 1:1 in Metern) — dieselben Werkzeuge, Befehle, Fang, Griffe, Vorschau/HUD, Auswahl, Undo und
// dasselbe Rendering wie im Grundriss (Wartungs-Feedback: „genau gleich wie im normalen Ausschnitt").
//
// Diese Datei liefert nur, was das Blatt zusätzlich hat: den Hintergrund unter der Zeichnung
// (Papier, Master-Rahmen + Titelblock, die platzierten Viewports mit ihrem echten Plan) als
// `backdrop` der PlanView, das Platzieren/Verschieben/Skalieren der Viewports (in Papier-mm) und
// die schlanke Blatt-Leiste (Zurück, Viewport aufziehen, Einpassen).
//
// Geometrie der Viewport-Griffe liegt rein + testbar in layoutSheetMath.ts.
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import type {
  Layout,
  LayoutGuide,
  LayoutImage,
  LayoutLegend,
  LayoutTitleBlock,
  LayoutOrientation,
  LayoutPaperFormat,
  LayoutTable,
  LayoutTableSource,
  LayoutViewport,
  Project,
  Vec2,
} from "../model/types";
import { createTable, PX_PER_M, sheetTables, TABLE_SOURCES, snapshotMono, snapshotOverrideRuleIds, snapshotTemplate, tableSourceLabel, viewportLevelPlan } from "../core";
import type { TableOut } from "../core";
import { SheetTableHud } from "./SheetTableHud";
import { isInModalDialog } from "../state/modalScope";
import { SheetImageHud } from "./SheetImageHud";
import { SheetGuidesHud } from "./SheetGuidesHud";
import {
  SNAP_PX,
  addGuide,
  clipToCrop,
  dragCropClip,
  moveGuide,
  removeGuide,
  snapRectToGuides,
  type GuideHit,
} from "./sheetSnap";
import { createLayoutImage, imageAspect, imageGeometry } from "../model/layoutImages";
import { posterHeaderItems, viewportScaleLabel } from "../model/posterTemplates";
import { planToPrintSvg } from "../export/planToPrintSvg";
import { legendPlan, legendPrintSvg } from "../export/legendSvg";
import { legendBox, legendEntries, legendKeysOfViewports, type LegendKind } from "../analysis/legend";
import {
  effectiveSheetSizeMm,
  findMaster,
  findSnapshot,
  resolveTitleBlock,
  resolveViewportScale,
  sheetMmToModel,
  sheetModelToMm,
  visibleCodesFromSnapshot,
} from "../model/layoutModel";
import {
  applyHandleDrag,
  clampRectToSheet,
  handleAnchors,
  handleCursor,
  normalizeRect,
  pickViewport,
  vpRect,
  type Handle,
  type RectMm,
} from "./layoutSheetMath";
import type { PlanSelection, PlanViewHandle } from "../views/plan/PlanView";
import { t } from "../i18n";
import { getState } from "../state/appStore";

// ── Geteilter Render-Kern ─────────────────────────────────────────────────────

/**
 * Rendert den ECHTEN Plan eines Viewports als verschachteltes `<svg>` in Blatt-mm: Ausschnitt
 * auflösen → `generatePlan` → `planToPrintSvg` beim effektiven Viewport-Massstab (Blattgrösse =
 * Viewport-mm-Grösse; das innere SVG klippt). Neu-Aufbau nur bei Projekt/Bindung/Grösse/Massstab,
 * nicht beim Verschieben (x/y setzt nur Attribute).
 */
export function ViewportPlanSvg({
  project,
  viewport,
  rect,
}: {
  project: Project;
  viewport: LayoutViewport;
  rect: RectMm;
}) {
  const ref = useRef<SVGGElement>(null);
  // Aktuelle Lage für das asynchron eintreffende SVG (Schnitt) — sonst sässe es bis zum nächsten Render falsch.
  const rectRef = useRef(rect);
  rectRef.current = rect;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const snap = findSnapshot(project, viewport.snapshotId);
    if (!snap) {
      el.replaceChildren();
      return;
    }
    let disposed = false;
    const codes = visibleCodesFromSnapshot(snap);
    // Massstab ZUERST: er geht in die Plan-Erzeugung ein (Bemassung in Papier-mm, s. model/dimension.ts).
    const scaleN = resolveViewportScale(viewport, snap);
    // Geschoss/Zeichnung wie bisher; Schnitt/Ansicht über die abgeleitete Projektion ([115], Schnitt asynchron).
    void viewportLevelPlan(project, snap.activeLevelId, codes, snap.detail, scaleN, false, snapshotMono(project, snap), snapshotOverrideRuleIds(project, snap), snapshotTemplate(project, snap), snap.modelViewOptionId)
      .then((plan) => {
        if (disposed) return;
        const print = planToPrintSvg(plan, {
          scaleDenominator: scaleN,
          pageWidthMm: viewport.widthMm,
          pageHeightMm: viewport.heightMm,
        });
        el.replaceChildren(print.svg);
        placeInner(el, rectRef.current);
      })
      .catch(() => {
        if (!disposed) el.replaceChildren();
      });
    return () => {
      disposed = true;
    };
  }, [project, viewport.snapshotId, viewport.widthMm, viewport.heightMm, viewport.scaleDenominator]);
  // Lage/Grösse über die Attribute des inneren SVG (folgt auch dem Ghost beim Ziehen).
  useEffect(() => {
    if (ref.current) placeInner(ref.current, rect);
  });
  return <g ref={ref} pointerEvents="none" />;
}

/** Lage/Grösse des inneren Viewport-SVG in Blatt-mm setzen. */
function placeInner(el: SVGGElement, rect: RectMm): void {
  const svg = el.firstElementChild;
  if (!svg) return;
  svg.setAttribute("x", String(rect.xMm));
  svg.setAttribute("y", String(rect.yMm));
  svg.setAttribute("width", String(rect.widthMm));
  svg.setAttribute("height", String(rect.heightMm));
  svg.setAttribute("preserveAspectRatio", "none");
}

/**
 * Legende ([82]) als verschachteltes `<svg>` in Blatt-mm: derselbe Weg wie im PDF (`legendPlan`, Schraffur-Muster
 * und Schrift vom Kern); folgt dem Projekt live, weil sie bei jeder Änderung neu aufgebaut wird.
 */
export function LegendSvg({ project, layout, legend }: { project: Project; layout: Layout; legend: LayoutLegend }) {
  const ref = useRef<SVGGElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      const lp = legendPlan(project, layout, legend);
      if (!lp) return void el.replaceChildren();
      const svg = legendPrintSvg(lp);
      svg.setAttribute("x", String(lp.xMm));
      svg.setAttribute("y", String(lp.yMm));
      svg.setAttribute("width", String(lp.widthMm));
      svg.setAttribute("height", String(lp.heightMm));
      el.replaceChildren(svg);
    } catch {
      el.replaceChildren();
    }
  }, [project, layout, legend]);
  return <g ref={ref} pointerEvents="none" data-legend-id={legend.id} />;
}

/**
 * Schlichtes Schriftfeld unten rechts (mm-Koordinaten des Blatts) mit den aufgelösten Master-Werten —
 * dieselbe Anmutung wie der PDF-Titelblock.
 */
export function TitleBlockSvg({
  sheet,
  tb,
  paper,
  orientation,
}: {
  sheet: { w: number; h: number };
  tb: { projectName: string; sheetName: string; scale: string; date: string; author: string; planNumber: string; revision?: string };
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
        {clip(tb.projectName, 28)}
      </text>
      <text x={x + boxW - 3} y={y + 5.6} fontSize={3.4} fontFamily="Helvetica, Arial, sans-serif" fontWeight="bold" fill="#111111" textAnchor="end">
        {tb.planNumber}
      </text>
      <text x={x + 3} y={y + 13} fontSize={3} fontFamily="Helvetica, Arial, sans-serif" fill="#111111">
        {clip(tb.sheetName, 36)}
      </text>
      {tb.revision && (
        <text x={x + boxW - 3} y={y + 13} fontSize={2.6} fontFamily="Helvetica, Arial, sans-serif" fill="#111111" textAnchor="end">
          {t("layouts.revision.short")} {tb.revision}
        </text>
      )}
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

// ── Blatt im Haupt-Viewport ───────────────────────────────────────────────────

export interface LayoutSheetHandlers {
  /** Zurück zur Modell-Ansicht (Grundriss/3D). */
  onBack: () => void;
  /** Ändert Position/Grösse/Massstab eines Viewports (mm). */
  onPatchViewport: (viewportId: string, patch: Partial<Omit<LayoutViewport, "id" | "snapshotId">>) => void;
  /** Entfernt einen Viewport per Id. */
  onRemoveViewport: (viewportId: string) => void;
  /** Fügt einen Viewport (gebunden an `snapshotId`) mit gegebener Geometrie an. */
  onAddViewport: (snapshotId: string, init: Partial<Omit<LayoutViewport, "id" | "snapshotId">>) => void;
  /** Legt eine Legende ([82]) an; liefert deren Id. */
  onAddLegend: (init: Omit<LayoutLegend, "id">) => string;
  /** Ändert Felder einer Legende (Titel, Lage, Arten, Handauswahl). */
  onPatchLegend: (legendId: string, patch: Partial<Omit<LayoutLegend, "id">>) => void;
  /** Entfernt eine Legende. */
  onRemoveLegend: (legendId: string) => void;
  /** Legt eine lebendige Tabelle auf dem Blatt an ([111]). */
  onAddTable: (table: LayoutTable) => void;
  /** Ändert eine Tabelle (Teil-Patch; gleiche `coalesceKey` fassen sich zu einem Undo-Schritt zusammen). */
  onPatchTable: (tableId: string, patch: Partial<Omit<LayoutTable, "id">>, coalesceKey?: string) => void;
  onRemoveTable: (tableId: string) => void;
  /** Setzt ein Bild (PNG/JPEG) auf das Blatt ([208]). */
  onAddImage: (image: LayoutImage) => void;
  /** Ändert ein Bild (Lage, Breite, Zuschnitt); gleiche `coalesceKey` = ein Undo-Schritt. */
  onPatchImage: (imageId: string, patch: Partial<Omit<LayoutImage, "id">>, coalesceKey?: string) => void;
  onRemoveImage: (imageId: string) => void;
  /** Setzt die Hilfslinien des Masters ([208]); gleiche `coalesceKey` = ein Undo-Schritt. Ohne Master wirkungslos. */
  onSetGuides?: (guides: LayoutGuide[], coalesceKey?: string) => void;
  /**
   * [137] Schriftfeld bearbeiten: Blattname/Plan-Nr./Index am Blatt, Projekt/Bearbeiter/Datum am Master
   * (gleiche `coalesceKey` = ein Undo-Schritt beim Tippen).
   */
  onPatchTitleBlock?: (layoutPatch: Partial<Pick<Layout, "name" | "planNumber" | "revision">>, masterPatch?: Partial<LayoutTitleBlock>) => void;
}

/** [137] Lage des Schriftfelds auf dem Blatt (mm, unten rechts; wie `TitleBlockSvg`). */
export function titleBlockBox(sheet: { w: number; h: number }): { xMm: number; yMm: number; widthMm: number; heightMm: number } {
  return { xMm: sheet.w - 76, yMm: sheet.h - 36, widthMm: 70, heightMm: 30 };
}

/** Was die Plan-Ansicht der Blatt-Ebene vom Blatt bekommt. */
export interface SheetPlanProps {
  /** Papier, Master und Viewports unter der Zeichnung (s. `PlanView.backdrop`). */
  backdrop: (origin: Vec2, pxPerMeter: number) => ReactNode;
  /** Einpassen = das ganze Blatt. */
  fitBounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Klick-Auswahl: trifft sie nichts Gezeichnetes, wählt sie den Viewport darunter. */
  onPlanSelect: (sel: PlanSelection) => void;
}

/** Fangzone/Grösse der Viewport-Griffe in Bildschirm-Pixeln. */
const GRIP_PX = 9;
/** Mindest-Kantenlänge eines Viewports (mm). */
const MIN_VP_MM = 8;
/** Mindest-Kantenlänge eines aufgezogenen Platzierungs-Rechtecks (mm). */
const MIN_PLACE_MM = 6;
/** Akzent der Viewport-Auswahl (wie bisher). */
const ACCENT = "#3b82f6";

type Drag =
  | { mode: "place"; x0: number; y0: number }
  | { mode: "edit"; id: string; handle: Handle; grab: { xMm: number; yMm: number }; start: RectMm };

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Trifft die Klick-Auswahl gar nichts Gezeichnetes (Leerraum)? */
function isEmptyPick(s: PlanSelection): boolean {
  return (
    s.hitIndex === null &&
    !s.wallId &&
    !s.drawingId &&
    !s.ceilingId &&
    !s.openingId &&
    !s.stairId &&
    !s.roomId &&
    !s.extrudedSolidId &&
    !s.columnId &&
    !s.roofId &&
    !s.sectionLineId &&
    !s.contextObjectId
  );
}

/**
 * Rahmen eines offenen Layout-Blatts um die Plan-Ansicht der Blatt-Ebene (`children`). Hält nur
 * den Viewport-Zustand (Auswahl, Platzieren, Ziehen); alles Zeichnen läuft in der Plan-Ansicht.
 */
export function LayoutSheetPane({
  project,
  layout,
  handlers,
  toolInputActive,
  onPlanSelect,
  planViewRef,
  children,
}: {
  project: Project;
  layout: Layout;
  handlers: LayoutSheetHandlers;
  /** Liegt die linke Maustaste beim Werkzeug/Befehl? Dann sind die Viewports nicht greifbar. */
  toolInputActive: boolean;
  onPlanSelect: (sel: PlanSelection) => void;
  planViewRef: RefObject<PlanViewHandle>;
  children: (props: SheetPlanProps) => ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLegendId, setSelectedLegendId] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  // Bilder ([208]): Auswahl und laufendes Verschieben/Skalieren (Ghost-Rahmen in mm).
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<{ id: string; rect: RectMm } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Zuschnitt-Modus ([208]): Bild-Id; während des Ziehens der Ausschnitt (mm) und das feststehende Original.
  const [cropId, setCropId] = useState<string | null>(null);
  const [cropPreview, setCropPreview] = useState<{ id: string; clip: RectMm; draw: RectMm } | null>(null);
  // Hilfslinien ([208]): Panel offen, laufender Zug (Lineal / bestehende Linie) und gerade gefangene Linien.
  const [guidesOpen, setGuidesOpen] = useState(false);
  const guidesToggleRef = useRef<HTMLButtonElement | null>(null);
  const [guideDrag, setGuideDrag] = useState<{ index: number; axis: "x" | "y"; posMm: number } | null>(null);
  const [snapHits, setSnapHits] = useState<GuideHit[]>([]);
  // [137] Schriftfeld angeklickt → Felder bearbeiten.
  const [titleBlockSelected, setTitleBlockSelected] = useState(false);
  // Tabellen-Verschiebung läuft (Versatz in mm), sonst null.
  const [tableDrag, setTableDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  // „Viewport aufziehen" armiert; danach folgt ggf. die Ausschnitt-Bindung.
  const [placing, setPlacing] = useState(false);
  // Live-Geometrie während Platzieren/Verschieben/Skalieren (Ghost), sonst null.
  const [preview, setPreview] = useState<{ drag: Drag; rect: RectMm } | null>(null);
  const [pendingRect, setPendingRect] = useState<RectMm | null>(null);
  const [bindSnapId, setBindSnapId] = useState("");
  const gRef = useRef<SVGGElement | null>(null);

  const master = findMaster(project, layout);
  // Effektive Grösse: ein gebundener Master gewinnt (wie im PDF-Export, `folderPdfPages`).
  const sheet = effectiveSheetSizeMm(master ?? layout);
  const titleBlock = resolveTitleBlock(project, layout, master);
  const drawBorder = master ? master.border ?? true : false;
  const snapshots = project.viewSnapshots ?? [];
  const selectedVp = layout.viewports.find((v) => v.id === selectedId) ?? null;
  const selectedLegend = (layout.legends ?? []).find((l) => l.id === selectedLegendId) ?? null;
  // Lebendige Tabellen: folgen dem Modell (jede Projekt-Änderung rechnet neu).
  const tables = useMemo(() => sheetTables(project, layout.id), [project, layout.id]);
  const layoutTables = layout.tables ?? [];
  const selectedTable = layoutTables.find((tb) => tb.id === selectedTableId) ?? null;
  const layoutImages = layout.images ?? [];
  const selectedImage = layoutImages.find((i) => i.id === selectedImageId) ?? null;
  const cropping = !!selectedImage && cropId === selectedImage.id;
  const guides = master?.guides;
  const canGuides = !!master && !!handlers.onSetGuides;

  // Gelöschter Viewport / anderes Blatt → Auswahl und laufendes Platzieren verwerfen.
  useEffect(() => {
    setSelectedId(null);
    setSelectedLegendId(null);
    setSelectedTableId(null);
    setSelectedImageId(null);
    setCropId(null);
    setTitleBlockSelected(false);
    setPlacing(false);
    setPendingRect(null);
  }, [layout.id]);
  // Ein Werkzeug/Befehl übernimmt die Maus → Viewport-Auswahl und Platzieren ruhen.
  useEffect(() => {
    if (toolInputActive) {
      setSelectedId(null);
      setPlacing(false);
    }
  }, [toolInputActive]);

  // Entf löscht den gewählten Viewport, Escape hebt Auswahl/Platzieren auf (nicht in Eingabefeldern).
  useEffect(() => {
    if (!selectedVp && !placing && !selectedTable && !selectedImage) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (isInModalDialog(el)) return; // [249] Dialog über dem Blatt: Entf/Esc gehören ihm
      if (cropId && (e.key === "Escape" || e.key === "Enter")) {
        setCropId(null);
      } else if (e.key === "Escape") {
        setSelectedId(null);
        setSelectedTableId(null);
        setSelectedImageId(null);
        setPlacing(false);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedImage && !selectedVp && !selectedTable) {
        e.preventDefault();
        e.stopPropagation();
        handlers.onRemoveImage(selectedImage.id);
        setSelectedImageId(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedTable && !selectedVp) {
        e.preventDefault();
        e.stopPropagation();
        handlers.onRemoveTable(selectedTable.id);
        setSelectedTableId(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedVp) {
        e.preventDefault();
        e.stopPropagation();
        handlers.onRemoveViewport(selectedVp.id);
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedVp, selectedTable, selectedImage, placing, handlers, cropId]);

  // Client-Pixel → Blatt-mm über die Bildschirm-Matrix der Blatt-Gruppe (enthält Pan/Zoom).
  const toMm = (clientX: number, clientY: number): { xMm: number; yMm: number } | null => {
    const m = gRef.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { xMm: p.x, yMm: p.y };
  };

  // Fang-Toleranz in mm: SNAP_PX Bildschirm-Pixel, über den Massstab der Blatt-Gruppe umgerechnet.
  const snapTolMm = (): number => {
    const m = gRef.current?.getScreenCTM();
    const pxPerMm = m ? Math.hypot(m.a, m.b) : 0;
    return pxPerMm > 0 ? SNAP_PX / pxPerMm : 0;
  };
  // Alt hält den Fang aus; ohne Hilfslinien tut er nichts.
  const snapOf = (rect: RectMm, handle: Handle, ev: PointerEvent, opts?: { minMm?: number; keepAspect?: number }) => {
    if (ev.altKey) {
      setSnapHits([]);
      return rect;
    }
    const s = snapRectToGuides(rect, handle, guides, snapTolMm(), opts);
    setSnapHits(s.hits);
    return s.rect;
  };

  const setGuidesNow = (next: LayoutGuide[], key?: string) => handlers.onSetGuides?.(next, key);

  // Hilfslinie ziehen: neu aus dem Lineal (index -1) oder eine bestehende; loslassen ausserhalb des Blatts löscht sie.
  const startGuideDrag = (e: ReactPointerEvent<Element>, axis: "x" | "y", index: number) => {
    if (e.button !== 0 || !canGuides) return;
    e.stopPropagation();
    e.preventDefault();
    let pos = index >= 0 && guides ? guides[index].posMm : NaN;
    const move = (ev: PointerEvent) => {
      const mm = toMm(ev.clientX, ev.clientY);
      if (!mm) return;
      pos = Math.round((axis === "x" ? mm.xMm : mm.yMm) * 10) / 10;
      setGuideDrag({ index, axis, posMm: pos });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setGuideDrag(null);
      if (!Number.isFinite(pos)) return;
      const inside = pos >= 0 && pos <= (axis === "x" ? sheet.w : sheet.h);
      if (index < 0) {
        if (inside) setGuidesNow(addGuide(guides, axis, pos));
      } else if (!inside) {
        setGuidesNow(removeGuide(guides, index));
      } else {
        setGuidesNow(moveGuide(guides, index, pos));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const startDrag = (e: ReactPointerEvent<SVGElement>, drag: Drag) => {
    if (e.button !== 0) return; // Mitte = Schwenken der Plan-Ansicht
    e.stopPropagation();
    e.preventDefault();
    const rect0 = drag.mode === "edit" ? drag.start : { xMm: drag.x0, yMm: drag.y0, widthMm: 0, heightMm: 0 };
    setPreview({ drag, rect: rect0 });
    let last = rect0;
    const move = (ev: PointerEvent) => {
      const mm = toMm(ev.clientX, ev.clientY);
      if (!mm) return;
      if (drag.mode === "place") {
        const q = snapOf({ xMm: mm.xMm, yMm: mm.yMm, widthMm: 0, heightMm: 0 }, "body", ev);
        last = normalizeRect(drag.x0, drag.y0, q.xMm, q.yMm);
      } else {
        const r = snapOf(applyHandleDrag(drag.start, drag.handle, mm.xMm - drag.grab.xMm, mm.yMm - drag.grab.yMm, MIN_VP_MM), drag.handle, ev, { minMm: MIN_VP_MM });
        last = drag.handle === "body" ? clampRectToSheet(r, sheet.w, sheet.h) : r;
      }
      setPreview({ drag, rect: last });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setPreview(null);
      setSnapHits([]);
      if (drag.mode === "place") {
        setPlacing(false);
        if (last.widthMm >= MIN_PLACE_MM && last.heightMm >= MIN_PLACE_MM) {
          const r = clampRectToSheet(last, sheet.w, sheet.h);
          if (snapshots.length === 1) handlers.onAddViewport(snapshots[0].id, r);
          else {
            setPendingRect(r);
            setBindSnapId("");
          }
        }
        return;
      }
      const s = drag.start;
      if (last.xMm === s.xMm && last.yMm === s.yMm && last.widthMm === s.widthMm && last.heightMm === s.heightMm) return;
      const r = clampRectToSheet(last, sheet.w, sheet.h);
      handlers.onPatchViewport(drag.id, {
        xMm: round1(r.xMm),
        yMm: round1(r.yMm),
        widthMm: round1(Math.max(MIN_VP_MM, r.widthMm)),
        heightMm: round1(Math.max(MIN_VP_MM, r.heightMm)),
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Tabelle verschieben: Versatz live als Transform, beim Loslassen ein Patch (x/y, auf 0.1 mm).
  const startTableDrag = (e: ReactPointerEvent<SVGElement>, table: LayoutTable) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const grab = toMm(e.clientX, e.clientY);
    if (!grab) return;
    let last = { dx: 0, dy: 0 };
    const move = (ev: PointerEvent) => {
      const mm = toMm(ev.clientX, ev.clientY);
      if (!mm) return;
      last = { dx: mm.xMm - grab.xMm, dy: mm.yMm - grab.yMm };
      const tb = tables.find((x) => x.id === table.id);
      if (tb) {
        const q = snapOf({ xMm: table.xMm + last.dx, yMm: table.yMm + last.dy, widthMm: tb.widthMm, heightMm: Math.max(tb.heightMm, 4) }, "body", ev);
        last = { dx: q.xMm - table.xMm, dy: q.yMm - table.yMm };
      }
      setTableDrag({ id: table.id, ...last });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setTableDrag(null);
      setSnapHits([]);
      if (last.dx === 0 && last.dy === 0) return;
      handlers.onPatchTable(table.id, { xMm: round1(table.xMm + last.dx), yMm: round1(table.yMm + last.dy) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Bild verschieben (Körper) oder an der unteren rechten Ecke skalieren (Seitenverhältnis bleibt): Ghost live,
  // beim Loslassen ein Patch (auf 0.1 mm).
  const startImageDrag = (e: ReactPointerEvent<SVGElement>, img: LayoutImage, handle: "body" | "se") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const grab = toMm(e.clientX, e.clientY);
    if (!grab) return;
    const aspect = imageAspect(img);
    let last: RectMm = { xMm: img.xMm, yMm: img.yMm, widthMm: img.widthMm, heightMm: img.heightMm };
    const move = (ev: PointerEvent) => {
      const mm = toMm(ev.clientX, ev.clientY);
      if (!mm) return;
      const dx = mm.xMm - grab.xMm;
      const dy = mm.yMm - grab.yMm;
      if (handle === "body") {
        last = snapOf({ xMm: img.xMm + dx, yMm: img.yMm + dy, widthMm: img.widthMm, heightMm: img.heightMm }, "body", ev);
      } else {
        const w = Math.max(MIN_VP_MM, img.widthMm + dx);
        last = snapOf({ xMm: img.xMm, yMm: img.yMm, widthMm: w, heightMm: w / aspect }, "se", ev, { minMm: MIN_VP_MM, keepAspect: aspect });
      }
      setImagePreview({ id: img.id, rect: last });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setImagePreview(null);
      setSnapHits([]);
      if (last.xMm === img.xMm && last.yMm === img.yMm && last.widthMm === img.widthMm) return;
      handlers.onPatchImage(img.id, { xMm: round1(last.xMm), yMm: round1(last.yMm), widthMm: round1(last.widthMm), heightMm: round1(last.heightMm) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Zuschneiden ([208]): das Original (draw) bleibt stehen, der Ausschnitt (clip) wandert; beim Loslassen ein Patch
  // mit neuem Rahmen + Zuschnitt (ein Undo-Schritt je Zug).
  const startCropDrag = (e: ReactPointerEvent<SVGElement>, img: LayoutImage, handle: Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const grab = toMm(e.clientX, e.clientY);
    if (!grab) return;
    const g = imageGeometry(img);
    const draw: RectMm = { xMm: g.draw.x, yMm: g.draw.y, widthMm: g.draw.w, heightMm: g.draw.h };
    const clip0: RectMm = { xMm: img.xMm, yMm: img.yMm, widthMm: img.widthMm, heightMm: img.heightMm };
    let last = clip0;
    const move = (ev: PointerEvent) => {
      const mm = toMm(ev.clientX, ev.clientY);
      if (!mm) return;
      last = dragCropClip(draw, clip0, handle, mm.xMm - grab.xMm, mm.yMm - grab.yMm);
      setCropPreview({ id: img.id, clip: last, draw });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setCropPreview(null);
      if (last === clip0) return;
      const r2 = (v: number) => Math.round(v * 100) / 100;
      handlers.onPatchImage(
        img.id,
        { crop: clipToCrop(draw, last), xMm: r2(last.xMm), yMm: r2(last.yMm), widthMm: r2(last.widthMm), heightMm: r2(last.heightMm) },
        `sheetImageCrop:${img.id}:${Date.now()}`,
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Bild mit laufendem Zuschnitt-Zug (Ausschnitt live).
  const effImage = (img: LayoutImage): LayoutImage => {
    if (!cropPreview || cropPreview.id !== img.id) return img;
    const c = cropPreview.clip;
    return { ...img, crop: clipToCrop(cropPreview.draw, c), xMm: c.xMm, yMm: c.yMm, widthMm: c.widthMm, heightMm: c.heightMm };
  };

  const imageRect = (img: LayoutImage): RectMm =>
    imagePreview && imagePreview.id === img.id ? imagePreview.rect : { xMm: img.xMm, yMm: img.yMm, widthMm: img.widthMm, heightMm: img.heightMm };

  // Bilddatei gewählt → mittig aufs Blatt, im Seitenverhältnis ([208]). Format erkennt der Kern am Dateikopf.
  const addImageFile = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const img = createLayoutImage(`img-${Date.now()}`, file.name, bytes, sheet, file.type === "image/jpeg" ? "image/jpeg" : "image/png");
    if (!img) {
      getState().notify(t("sheetImage.invalid"), "warning");
      return;
    }
    handlers.onAddImage(img);
    setSelectedImageId(img.id);
    setSelectedId(null);
    setSelectedTableId(null);
    setSelectedLegendId(null);
  };

  const displayRect = (vp: LayoutViewport): RectMm =>
    preview && preview.drag.mode === "edit" && preview.drag.id === vp.id ? preview.rect : vpRect(vp);

  const backdrop = (origin: Vec2, pxPerMeter: number): ReactNode => {
    const k = PX_PER_M / 1000; // viewBox-Einheiten je mm
    const pxPerMm = pxPerMeter / 1000;
    const grip = pxPerMm > 0 ? GRIP_PX / pxPerMm : 2;
    const hair = pxPerMm > 0 ? 1 / pxPerMm : 0.3; // 1 Bildschirm-Pixel in mm
    const editable = !toolInputActive;
    return (
      <g ref={gRef} transform={`translate(${-origin.x} ${-origin.y}) scale(${k})`} data-sheet-backdrop>
        {/* Papier mit leichtem Schatten (Bildschirm-Pixel), Rand 1 px. */}
        <rect x={hair * 2} y={hair * 4} width={sheet.w} height={sheet.h} fill="rgba(26,26,24,0.16)" pointerEvents="none" />
        <rect x={0} y={0} width={sheet.w} height={sheet.h} fill="#ffffff" stroke="rgba(26,26,24,0.25)" strokeWidth={hair} pointerEvents="none" />
        {drawBorder && (
          <rect x={5} y={5} width={sheet.w - 10} height={sheet.h - 10} fill="none" stroke="#111111" strokeWidth={0.35} pointerEvents="none" />
        )}
        {master?.posterHeader && (
          <g pointerEvents="none" data-poster-header>
            {posterHeaderItems(project, layout, master, sheet).map((it, i) =>
              it.kind === "rect" ? (
                <rect key={i} x={it.x} y={it.y} width={it.w} height={it.h} fill="none" stroke="#111111" strokeWidth={it.stroke} />
              ) : (
                <text
                  key={i}
                  x={it.x}
                  y={it.y}
                  fontSize={it.sizeMm}
                  fontFamily="Helvetica, Arial, sans-serif"
                  fontWeight={it.bold ? "bold" : "normal"}
                  textAnchor={it.align === "center" ? "middle" : it.align === "right" ? "end" : "start"}
                  fill="#111111"
                >
                  {it.text}
                </text>
              ),
            )}
          </g>
        )}
        {master && (
          <g pointerEvents="none">
            <TitleBlockSvg sheet={sheet} tb={titleBlock} paper={layout.paper} orientation={layout.orientation} />
            {titleBlockSelected && (
              <rect {...rectAttrs(titleBlockBox(sheet))} fill="none" stroke={ACCENT} strokeWidth={hair * 1.5} data-titleblock-selected />
            )}
          </g>
        )}
        {layout.viewports.map((vp) => {
          const r = displayRect(vp);
          const snap = findSnapshot(project, vp.snapshotId);
          return (
            <g key={vp.id} data-viewport-id={vp.id}>
              {snap ? (
                <ViewportPlanSvg project={project} viewport={vp} rect={r} />
              ) : (
                <g pointerEvents="none">
                  <rect x={r.xMm} y={r.yMm} width={r.widthMm} height={r.heightMm} fill="#fff6f6" />
                  <text x={r.xMm + r.widthMm / 2} y={r.yMm + r.heightMm / 2} fontSize={3} fill="#b00" textAnchor="middle">
                    {t("layouts.missingSnapshot")}
                  </text>
                </g>
              )}
              <rect
                x={r.xMm}
                y={r.yMm}
                width={r.widthMm}
                height={r.heightMm}
                fill="none"
                stroke={vp.id === selectedId ? ACCENT : "rgba(0,0,0,0.35)"}
                strokeWidth={hair * (vp.id === selectedId ? 1.5 : 1)}
                pointerEvents="none"
              />
            </g>
          );
        })}
        {/* Hilfslinien greifbar machen ([208]): breite, unsichtbare Trefferlinien unter allen Griffen; Doppelklick löscht. */}
        {canGuides && editable && !placing && (
          <g data-guide-hits>
            {(guides ?? []).map((gd, i) => {
              const w = hair * 8;
              return gd.axis === "x" ? (
                <line key={i} x1={gd.posMm} y1={0} x2={gd.posMm} y2={sheet.h} stroke="transparent" strokeWidth={w} style={{ cursor: "ew-resize" }} data-guide-hit={i} onPointerDown={(e) => startGuideDrag(e, "x", i)} onDoubleClick={() => setGuidesNow(removeGuide(guides, i))} />
              ) : (
                <line key={i} x1={0} y1={gd.posMm} x2={sheet.w} y2={gd.posMm} stroke="transparent" strokeWidth={w} style={{ cursor: "ns-resize" }} data-guide-hit={i} onPointerDown={(e) => startGuideDrag(e, "y", i)} onDoubleClick={() => setGuidesNow(removeGuide(guides, i))} />
              );
            })}
          </g>
        )}
        {/* Bilder ([208]): über den Viewports, unter Legenden und Tabellen. */}
        {layoutImages.map((img0) => {
          const img = effImage(img0);
          const r = imageRect(img);
          const g = imageGeometry({ ...img, xMm: r.xMm, yMm: r.yMm, widthMm: r.widthMm, heightMm: r.heightMm });
          // Im Zuschnitt-Modus: das ganze Original blass dahinter (es bleibt stehen).
          const orig = cropPreview && cropPreview.id === img.id ? cropPreview.draw : { xMm: g.draw.x, yMm: g.draw.y, widthMm: g.draw.w, heightMm: g.draw.h };
          return (
            <g key={img.id} data-image-id={img.id}>
              {cropping && img.id === cropId && (
                <image href={img.src} x={orig.xMm} y={orig.yMm} width={orig.widthMm} height={orig.heightMm} preserveAspectRatio="none" opacity={0.3} pointerEvents="none" data-crop-original />
              )}
              <svg x={g.clip.x} y={g.clip.y} width={g.clip.w} height={g.clip.h} viewBox={`${g.clip.x} ${g.clip.y} ${g.clip.w} ${g.clip.h}`} overflow="hidden" pointerEvents="none">
                <image href={img.src} x={g.draw.x} y={g.draw.y} width={g.draw.w} height={g.draw.h} preserveAspectRatio="none" />
              </svg>
              {img.id === selectedImageId && (
                <rect {...rectAttrs(r)} fill="none" stroke={ACCENT} strokeWidth={hair * 1.5} pointerEvents="none" data-image-selected />
              )}
            </g>
          );
        })}
        {/* Massstab unter jedem Viewport (Master „Massstabsangaben"). */}
        {master?.viewportScaleLabels &&
          layout.viewports.map((vp) => {
            const l = viewportScaleLabel(project, vp, sheet);
            return l ? (
              <text key={`sl-${vp.id}`} x={l.x} y={l.y} fontSize={l.sizeMm} fontFamily="Helvetica, Arial, sans-serif" fill="#111111" pointerEvents="none" data-scale-label>
                {l.text}
              </text>
            ) : null;
          })}
        {(layout.legends ?? []).map((lg) => {
          const box = legendBox(project, layout, lg);
          return (
            <g key={lg.id}>
              <LegendSvg project={project} layout={layout} legend={lg} />
              {lg.id === selectedLegendId && (
                <rect {...rectAttrs(box)} fill="none" stroke={ACCENT} strokeWidth={hair * 1.5} pointerEvents="none" data-legend-selected />
              )}
            </g>
          );
        })}
        {/* Lebendige Tabellen ([111]): Text + Linien aus dem Kern, über den Viewports. */}
        {tables.map((tb) => {
          const off = tableDrag && tableDrag.id === tb.id ? tableDrag : null;
          const src = layoutTables.find((x) => x.id === tb.id);
          return (
            <g key={tb.id} data-table-id={tb.id} transform={off ? `translate(${off.dx} ${off.dy})` : undefined}>
              {tb.prims.map((p, i) =>
                p.k === "line" ? (
                  <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke="#111111" strokeWidth={p.w} pointerEvents="none" />
                ) : (
                  <text
                    key={i}
                    x={p.x}
                    y={p.y}
                    fontSize={p.size}
                    fontFamily={p.font === "serif" ? "Times, serif" : p.font === "mono" ? "Courier, monospace" : "Helvetica, Arial, sans-serif"}
                    fontWeight={p.bold ? "bold" : "normal"}
                    fontStyle={p.italic ? "italic" : "normal"}
                    textAnchor={p.align === "r" ? "end" : "start"}
                    fill="#111111"
                    pointerEvents="none"
                  >
                    {p.s}
                  </text>
                ),
              )}
              {src && (
                <rect
                  x={src.xMm}
                  y={src.yMm}
                  width={tb.widthMm}
                  height={Math.max(tb.heightMm, 4)}
                  fill="transparent"
                  stroke={tb.id === selectedTableId ? ACCENT : "none"}
                  strokeWidth={hair * 1.5}
                  strokeDasharray={`${hair * 4} ${hair * 3}`}
                  pointerEvents={tb.id === selectedTableId && editable ? "all" : "none"}
                  style={{ cursor: "move" }}
                  data-table-body
                  onPointerDown={(e) => startTableDrag(e, src)}
                />
              )}
            </g>
          );
        })}
        {/* Gewählter Viewport: Körper (verschieben) + 8 Griffe (skalieren) — nur im Auswahl-Modus. */}
        {selectedVp && editable && (
          <g>
            <rect
              {...rectAttrs(displayRect(selectedVp))}
              fill="transparent"
              style={{ cursor: "move" }}
              data-viewport-body
              onPointerDown={(e) => {
                const grab = toMm(e.clientX, e.clientY);
                if (grab) startDrag(e, { mode: "edit", id: selectedVp.id, handle: "body", grab, start: vpRect(selectedVp) });
              }}
            />
            {handleAnchors(displayRect(selectedVp)).map((a) => (
              <rect
                key={a.handle}
                x={a.xMm - grip / 2}
                y={a.yMm - grip / 2}
                width={grip}
                height={grip}
                fill="#ffffff"
                stroke={ACCENT}
                strokeWidth={hair * 1.5}
                style={{ cursor: handleCursor(a.handle) }}
                data-viewport-grip={a.handle}
                onPointerDown={(e) => {
                  const grab = toMm(e.clientX, e.clientY);
                  if (grab) startDrag(e, { mode: "edit", id: selectedVp.id, handle: a.handle, grab, start: vpRect(selectedVp) });
                }}
              />
            ))}
          </g>
        )}
        {/* Gewähltes Bild: Körper verschieben, Ecke unten rechts skalieren; im Zuschnitt-Modus Griffe am Ausschnitt. */}
        {selectedImage && editable && !cropping && (
          <g>
            <rect
              {...rectAttrs(imageRect(selectedImage))}
              fill="transparent"
              style={{ cursor: "move" }}
              data-image-body
              onPointerDown={(e) => startImageDrag(e, selectedImage, "body")}
              onDoubleClick={() => setCropId(selectedImage.id)}
            />
            <rect
              x={imageRect(selectedImage).xMm + imageRect(selectedImage).widthMm - grip / 2}
              y={imageRect(selectedImage).yMm + imageRect(selectedImage).heightMm - grip / 2}
              width={grip}
              height={grip}
              fill="#ffffff"
              stroke={ACCENT}
              strokeWidth={hair * 1.5}
              style={{ cursor: "nwse-resize" }}
              data-image-grip="se"
              onPointerDown={(e) => startImageDrag(e, selectedImage, "se")}
            />
          </g>
        )}
        {selectedImage && editable && cropping && (() => {
          const clip = effImage(selectedImage);
          const cr: RectMm = { xMm: clip.xMm, yMm: clip.yMm, widthMm: clip.widthMm, heightMm: clip.heightMm };
          const og = imageGeometry(selectedImage);
          const dr: RectMm = cropPreview?.draw ?? { xMm: og.draw.x, yMm: og.draw.y, widthMm: og.draw.w, heightMm: og.draw.h };
          return (
            <g data-image-crop>
              <rect {...rectAttrs(dr)} fill="none" stroke={ACCENT} strokeWidth={hair} strokeDasharray={`${hair * 4} ${hair * 3}`} pointerEvents="none" />
              <rect
                {...rectAttrs(cr)}
                fill="transparent"
                stroke={ACCENT}
                strokeWidth={hair * 1.5}
                style={{ cursor: "move" }}
                data-crop-body
                onPointerDown={(e) => startCropDrag(e, selectedImage, "body")}
              />
              {handleAnchors(cr).map((a) => (
                <rect
                  key={a.handle}
                  x={a.xMm - grip / 2}
                  y={a.yMm - grip / 2}
                  width={grip}
                  height={grip}
                  fill="#ffffff"
                  stroke={ACCENT}
                  strokeWidth={hair * 1.5}
                  style={{ cursor: handleCursor(a.handle) }}
                  data-crop-grip={a.handle}
                  onPointerDown={(e) => startCropDrag(e, selectedImage, a.handle)}
                />
              ))}
            </g>
          );
        })()}
        {/* Hilfslinien des Gestaltungsrasters ([208]): nur am Bildschirm, nie im Druck; gefangene Linie kräftiger. */}
        {((guides ?? []).length > 0 || guideDrag) && (
          <g pointerEvents="none" data-guides>
            {(guides ?? []).map((gd, i) => {
              const moving = guideDrag && guideDrag.index === i;
              const pos = moving ? guideDrag.posMm : gd.posMm;
              const hit = snapHits.some((h) => h.axis === gd.axis && h.posMm === gd.posMm);
              const common = { stroke: hit ? "#0e7490" : "#06b6d4", strokeWidth: hair * (hit ? 2 : 1), strokeDasharray: hit ? undefined : `${hair * 6} ${hair * 4}`, opacity: hit ? 1 : 0.7 };
              return gd.axis === "x" ? (
                <line key={i} x1={pos} y1={0} x2={pos} y2={sheet.h} {...common} />
              ) : (
                <line key={i} x1={0} y1={pos} x2={sheet.w} y2={pos} {...common} />
              );
            })}
          </g>
        )}
        {guideDrag && guideDrag.index < 0 && (
          <line
            data-guide-new
            x1={guideDrag.axis === "x" ? guideDrag.posMm : 0}
            x2={guideDrag.axis === "x" ? guideDrag.posMm : sheet.w}
            y1={guideDrag.axis === "y" ? guideDrag.posMm : 0}
            y2={guideDrag.axis === "y" ? guideDrag.posMm : sheet.h}
            stroke="#06b6d4"
            strokeWidth={hair * 1.5}
            pointerEvents="none"
          />
        )}
        {/* Viewport aufziehen: das ganze Blatt fängt den Zug. */}
        {placing && editable && (
          <rect
            x={0}
            y={0}
            width={sheet.w}
            height={sheet.h}
            fill="transparent"
            style={{ cursor: "crosshair" }}
            data-viewport-place
            onPointerDown={(e) => {
              const p = toMm(e.clientX, e.clientY);
              if (p) startDrag(e, { mode: "place", x0: p.xMm, y0: p.yMm });
            }}
          />
        )}
        {preview && preview.drag.mode === "place" && (
          <rect
            {...rectAttrs(preview.rect)}
            fill="rgba(59,130,246,0.12)"
            stroke={ACCENT}
            strokeWidth={hair * 1.5}
            strokeDasharray={`${hair * 4} ${hair * 3}`}
            pointerEvents="none"
          />
        )}
      </g>
    );
  };

  // Einpassen = das Blatt (Modell-Meter, y nach oben).
  const fitBounds = useMemo(() => {
    const a = sheetMmToModel(0, sheet.h);
    const b = sheetMmToModel(sheet.w, 0);
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }, [sheet.w, sheet.h]);

  // Klick ins Leere über einem Viewport wählt ihn (Zeichnung darüber hat Vorrang: PlanView trifft sie).
  const onSheetSelect = (sel: PlanSelection) => {
    if (!toolInputActive && isEmptyPick(sel)) {
      const mm = sheetModelToMm(sel.model);
      // Tabelle zuerst (liegt über den Viewports), dann Legende, dann Viewport.
      const tableHit = [...tables].reverse().find((tb) => {
        const src = layoutTables.find((x) => x.id === tb.id);
        return src && mm.xMm >= src.xMm && mm.xMm <= src.xMm + tb.widthMm && mm.yMm >= src.yMm && mm.yMm <= src.yMm + Math.max(tb.heightMm, 4);
      });
      setSelectedTableId(tableHit ? tableHit.id : null);
      const lg = tableHit
        ? undefined
        : [...(layout.legends ?? [])].reverse().find((l) => {
            const b = legendBox(project, layout, l);
            return mm.xMm >= b.xMm && mm.xMm <= b.xMm + b.widthMm && mm.yMm >= b.yMm && mm.yMm <= b.yMm + b.heightMm;
          });
      setSelectedLegendId(lg ? lg.id : null);
      // Schriftfeld (liegt über den Viewports, nur mit Master gezeichnet).
      const tbb = titleBlockBox(sheet);
      const onTitle = !tableHit && !lg && !!master && !!handlers.onPatchTitleBlock &&
        mm.xMm >= tbb.xMm && mm.xMm <= tbb.xMm + tbb.widthMm && mm.yMm >= tbb.yMm && mm.yMm <= tbb.yMm + tbb.heightMm;
      setTitleBlockSelected(onTitle);
      const imgHit = tableHit || lg || onTitle
        ? undefined
        : [...layoutImages].reverse().find((i) => mm.xMm >= i.xMm && mm.xMm <= i.xMm + i.widthMm && mm.yMm >= i.yMm && mm.yMm <= i.yMm + i.heightMm);
      setSelectedImageId(imgHit ? imgHit.id : null);
      const hit = tableHit || lg || onTitle || imgHit ? null : pickViewport(layout.viewports, mm.xMm, mm.yMm, 0);
      setSelectedId(hit ? hit.id : null);
    } else {
      setSelectedId(null);
      setSelectedImageId(null);
      setSelectedTableId(null);
      setSelectedLegendId(null);
      setTitleBlockSelected(false);
    }
    onPlanSelect(sel);
  };

  const confirmBind = () => {
    if (bindSnapId && pendingRect) handlers.onAddViewport(bindSnapId, pendingRect);
    setPendingRect(null);
    setBindSnapId("");
  };

  return (
    <section className="pane layout-sheet-pane">
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
            setSelectedId(null);
          }}
          disabled={snapshots.length === 0 || toolInputActive}
          title={snapshots.length === 0 ? t("layouts.noSnapshots") : t("layouts.placeViewport")}
        >
          ＋ {t("layouts.placeViewport")}
        </button>
        <button
          className="nav-add"
          data-add-legend
          disabled={toolInputActive}
          title={t("legend.add")}
          onClick={() => {
            const id = handlers.onAddLegend({ xMm: 10, yMm: 10 });
            setSelectedId(null);
            setSelectedLegendId(id);
          }}
        >
          ＋ {t("legend.add")}
        </button>
        <select
          className="res-select"
          value=""
          disabled={toolInputActive}
          title={t("sheetTable.add")}
          data-table-add
          onChange={(e) => {
            const source = e.target.value as LayoutTableSource;
            if (!source) return;
            const tb = createTable(`tb-${Date.now()}`, source, sheet.w, sheet.h, layoutTables);
            handlers.onAddTable(tb);
            setSelectedTableId(tb.id);
            setSelectedId(null);
          }}
        >
          <option value="">＋ {t("sheetTable.add")}</option>
          {TABLE_SOURCES.map((src) => (
            <option key={src} value={src}>{tableSourceLabel(src)}</option>
          ))}
        </select>
        <button className="nav-add" data-add-image disabled={toolInputActive} title={t("sheetImage.add")} onClick={() => fileRef.current?.click()}>
          ＋ {t("sheetImage.add")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          style={{ display: "none" }}
          data-testid="sheet-image-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void addImageFile(f);
          }}
        />
        <button
          ref={guidesToggleRef}
          className={`nav-add${guidesOpen ? " active" : ""}`}
          data-guides-toggle
          disabled={!canGuides}
          title={canGuides ? t("sheetGuides.title") : t("sheetGuides.needMaster")}
          onClick={() => setGuidesOpen((v) => !v)}
        >
          {t("sheetGuides.title")}
        </button>
        <span style={{ flex: 1 }} />
        <button className="nav-add" onClick={() => planViewRef.current?.fit()} title={t("layouts.fit")}>
          {t("layouts.fit")}
        </button>
      </div>

      <div className="layout-sheet-stage">
        {children({ backdrop, fitBounds, onPlanSelect: onSheetSelect })}

        {/* Hilfslinien aus dem Lineal ziehen ([208]): oben → waagrechte, links → senkrechte Linie. */}
        {canGuides && !toolInputActive && (
          <>
            <div
              className="layout-sheet-ruler-grab layout-sheet-ruler-top"
              data-sheet-ui
              data-ruler-grab="y"
              title={t("sheetGuides.dragHint")}
              onPointerDown={(e) => startGuideDrag(e, "y", -1)}
            />
            <div
              className="layout-sheet-ruler-grab layout-sheet-ruler-left"
              data-sheet-ui
              data-ruler-grab="x"
              title={t("sheetGuides.dragHint")}
              onPointerDown={(e) => startGuideDrag(e, "x", -1)}
            />
          </>
        )}
        {guidesOpen && canGuides && (
          <SheetGuidesHud
            guides={guides ?? []}
            onAdd={(axis, posMm) => setGuidesNow(addGuide(guides, axis, posMm))}
            onMove={(i, posMm) => setGuidesNow(moveGuide(guides, i, posMm), `sheetGuide:${layout.id}:${i}`)}
            onRemove={(i) => setGuidesNow(removeGuide(guides, i))}
            onClear={() => setGuidesNow([])}
            onClose={() => {
              setGuidesOpen(false);
              // [249] Fokus zurück zum Knopf, der das Panel geöffnet hat.
              requestAnimationFrame(() => guidesToggleRef.current?.focus());
            }}
          />
        )}

        {/* Eigenschaften des gewählten Viewports (Massstab/Grösse/Löschen). */}
        {selectedVp && (
          <div className="layout-sheet-hud" data-sheet-ui>
            <div className="layout-sheet-hud-title">
              {findSnapshot(project, selectedVp.snapshotId)?.name ?? t("layouts.missingSnapshot")}
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
                  value={resolveViewportScale(selectedVp, findSnapshot(project, selectedVp.snapshotId))}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isFinite(v) && v > 0) handlers.onPatchViewport(selectedVp.id, { scaleDenominator: v });
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
                  onClick={() => handlers.onPatchViewport(selectedVp.id, { scaleDenominator: undefined })}
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

        {/* [137] Schriftfeld: Felder direkt bearbeiten. */}
        {titleBlockSelected && master && handlers.onPatchTitleBlock && (
          <div className="layout-sheet-hud" data-sheet-ui data-testid="titleblock-hud">
            <div className="layout-sheet-hud-title">{t("layouts.tb.title")}</div>
            {([
              ["sheetName", layout.name, (v: string) => handlers.onPatchTitleBlock!({ name: v })],
              ["planNumber", layout.planNumber ?? "", (v: string) => handlers.onPatchTitleBlock!({ planNumber: v || undefined })],
              ["revision", layout.revision ?? "", (v: string) => handlers.onPatchTitleBlock!({ revision: v || undefined })],
              ["projectName", master.titleBlock.projectName ?? "", (v: string) => handlers.onPatchTitleBlock!({}, { projectName: v })],
              ["author", master.titleBlock.author ?? "", (v: string) => handlers.onPatchTitleBlock!({}, { author: v })],
              ["date", master.titleBlock.date ?? "", (v: string) => handlers.onPatchTitleBlock!({}, { date: v })],
            ] as const).map(([key, value, set]) => (
              <label key={key} className="layout-sheet-hud-row">
                <span>{t(`layouts.tb.${key}`)}</span>
                <input
                  type="text"
                  className="res-input"
                  data-tb-field={key}
                  value={value}
                  placeholder={t("layouts.tb.autoPlaceholder")}
                  onChange={(e) => set(e.target.value)}
                />
              </label>
            ))}
          </div>
        )}

        {/* Eigenschaften der gewählten Legende ([82]). */}
        {selectedLegend && (
          <LegendHud
            project={project}
            layout={layout}
            legend={selectedLegend}
            onPatch={(patch) => handlers.onPatchLegend(selectedLegend.id, patch)}
            onRemove={() => {
              handlers.onRemoveLegend(selectedLegend.id);
              setSelectedLegendId(null);
            }}
          />
        )}

        {/* Eigenschaften des gewählten Bilds ([208]). */}
        {selectedImage && !selectedVp && !selectedTable && (
          <SheetImageHud
            image={selectedImage}
            cropping={cropping}
            onToggleCrop={() => setCropId(cropping ? null : selectedImage.id)}
            onPatch={(patch) => handlers.onPatchImage(selectedImage.id, patch, `sheetImage:${selectedImage.id}`)}
            onRemove={() => {
              handlers.onRemoveImage(selectedImage.id);
              setSelectedImageId(null);
            }}
          />
        )}

        {/* Eigenschaften der gewählten Tabelle ([111]). */}
        {selectedTable && !selectedVp && (
          <SheetTableHud
            project={project}
            table={selectedTable}
            others={layoutTables.filter((o) => o.id !== selectedTable.id)}
            out={tables.find((tb: TableOut) => tb.id === selectedTable.id)}
            onPatch={(patch) => handlers.onPatchTable(selectedTable.id, patch, `sheetTable:${selectedTable.id}`)}
            onRemove={() => {
              handlers.onRemoveTable(selectedTable.id);
              setSelectedTableId(null);
            }}
          />
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

        {/* Hinweis beim Platzieren bzw. ohne Ausschnitte. */}
        {(placing || snapshots.length === 0) && !pendingRect && layout.viewports.length === 0 && (
          <div className="layout-sheet-empty" data-sheet-ui>
            {snapshots.length === 0 ? t("layouts.noSnapshots") : t("layouts.placeHint")}
          </div>
        )}
      </div>
    </section>
  );
}

function rectAttrs(r: RectMm) {
  return { x: r.xMm, y: r.yMm, width: r.widthMm, height: r.heightMm };
}

const LEGEND_KINDS: LegendKind[] = ["hatch", "lineType", "category"];

/** Eigenschaften einer Legende: Titel, Lage, gezeigte Arten, automatisch/festgehalten, Löschen. */
function LegendHud({
  project,
  layout,
  legend,
  onPatch,
  onRemove,
}: {
  project: Project;
  layout: Layout;
  legend: LayoutLegend;
  onPatch: (patch: Partial<Omit<LayoutLegend, "id">>) => void;
  onRemove: () => void;
}) {
  const kinds = new Set<string>(legend.kinds?.length ? legend.kinds : ["hatch"]);
  const manual = (legend.manualKeys ?? []).length > 0;
  const num = (v: number, set: (n: number) => void) => (
    <input
      type="number"
      className="res-input mono num"
      step={1}
      value={Math.round(v * 10) / 10}
      onChange={(e) => {
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) set(n);
      }}
    />
  );
  return (
    <div className="layout-sheet-hud" data-sheet-ui data-legend-hud>
      <div className="layout-sheet-hud-title">{t("legend.add")}</div>
      <label className="layout-sheet-hud-row">
        <span>{t("legend.title")}</span>
        <input
          type="text"
          className="res-input"
          value={legend.title ?? ""}
          placeholder={t("legend.defaultTitle")}
          onChange={(e) => onPatch({ title: e.target.value || undefined })}
        />
      </label>
      <div className="layout-sheet-hud-row">
        <span>X / Y mm</span>
        <span className="layout-sheet-hud-scale">
          {num(legend.xMm, (xMm) => onPatch({ xMm }))}
          {num(legend.yMm, (yMm) => onPatch({ yMm }))}
        </span>
      </div>
      {LEGEND_KINDS.map((k) => (
        <label key={k} className="layout-sheet-hud-row">
          <input
            type="checkbox"
            checked={kinds.has(k)}
            onChange={(e) => {
              const next = new Set(kinds);
              if (e.target.checked) next.add(k);
              else next.delete(k);
              onPatch({ kinds: next.size > 0 ? LEGEND_KINDS.filter((x) => next.has(x)) : ["hatch"] });
            }}
          />
          <span>{t(`legend.kind.${k}`)}</span>
        </label>
      ))}
      <div className="layout-sheet-hud-size">
        {t("legend.entries")}: {legendEntries(project, layout, legend).length}
        {manual ? ` · ${t("legend.manual")}` : ` · ${t("legend.auto")}`}
      </div>
      <div className="layout-sheet-hud-actions">
        {manual ? (
          <button className="nav-add" onClick={() => onPatch({ manualKeys: undefined })}>
            {t("legend.auto")}
          </button>
        ) : (
          <button className="nav-add" onClick={() => onPatch({ manualKeys: legendKeysOfViewports(project, layout) })} title={t("legend.freeze.hint")}>
            {t("legend.freeze")}
          </button>
        )}
        <button className="nav-add" onClick={onRemove} title={t("legend.remove")}>
          <span className="material-symbols-outlined" aria-hidden="true">delete</span>
        </button>
      </div>
    </div>
  );
}
