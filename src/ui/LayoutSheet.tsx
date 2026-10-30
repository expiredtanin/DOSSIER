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
  LayoutOrientation,
  LayoutPaperFormat,
  LayoutTable,
  LayoutTableSource,
  LayoutViewport,
  Project,
  Vec2,
} from "../model/types";
import { createTable, generatePlan, PX_PER_M, sheetTables, TABLE_SOURCES, tableSourceLabel } from "../core";
import type { TableOut } from "../core";
import { SheetTableHud } from "./SheetTableHud";
import { planToPrintSvg } from "../export/planToPrintSvg";
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
      // Massstab ZUERST: er geht in die Plan-Erzeugung ein (Bemassung in Papier-mm, s. model/dimension.ts).
      const scaleN = resolveViewportScale(viewport, snap);
      const plan = generatePlan(project, snap.activeLevelId, codes, undefined, snap.detail, false, false, true, scaleN);
      const print = planToPrintSvg(plan, {
        scaleDenominator: scaleN,
        pageWidthMm: viewport.widthMm,
        pageHeightMm: viewport.heightMm,
      });
      el.replaceChildren(print.svg);
    } catch {
      el.replaceChildren();
    }
  }, [project, viewport.snapshotId, viewport.widthMm, viewport.heightMm, viewport.scaleDenominator]);
  // Lage/Grösse über die Attribute des inneren SVG (folgt auch dem Ghost beim Ziehen).
  useEffect(() => {
    const svg = ref.current?.firstElementChild;
    if (!svg) return;
    svg.setAttribute("x", String(rect.xMm));
    svg.setAttribute("y", String(rect.yMm));
    svg.setAttribute("width", String(rect.widthMm));
    svg.setAttribute("height", String(rect.heightMm));
    svg.setAttribute("preserveAspectRatio", "none");
  });
  return <g ref={ref} pointerEvents="none" />;
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
  tb: { projectName: string; sheetName: string; scale: string; date: string; author: string; planNumber: string };
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
  /** Legt eine lebendige Tabelle auf dem Blatt an ([111]). */
  onAddTable: (table: LayoutTable) => void;
  /** Ändert eine Tabelle (Teil-Patch; gleiche `coalesceKey` fassen sich zu einem Undo-Schritt zusammen). */
  onPatchTable: (tableId: string, patch: Partial<Omit<LayoutTable, "id">>, coalesceKey?: string) => void;
  onRemoveTable: (tableId: string) => void;
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
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
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
  // Lebendige Tabellen: folgen dem Modell (jede Projekt-Änderung rechnet neu).
  const tables = useMemo(() => sheetTables(project, layout.id), [project, layout.id]);
  const layoutTables = layout.tables ?? [];
  const selectedTable = layoutTables.find((tb) => tb.id === selectedTableId) ?? null;

  // Gelöschter Viewport / anderes Blatt → Auswahl und laufendes Platzieren verwerfen.
  useEffect(() => {
    setSelectedId(null);
    setSelectedTableId(null);
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
    if (!selectedVp && !placing && !selectedTable) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === "Escape") {
        setSelectedId(null);
        setSelectedTableId(null);
        setPlacing(false);
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
  }, [selectedVp, selectedTable, placing, handlers]);

  // Client-Pixel → Blatt-mm über die Bildschirm-Matrix der Blatt-Gruppe (enthält Pan/Zoom).
  const toMm = (clientX: number, clientY: number): { xMm: number; yMm: number } | null => {
    const m = gRef.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { xMm: p.x, yMm: p.y };
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
        last = normalizeRect(drag.x0, drag.y0, mm.xMm, mm.yMm);
      } else {
        const r = applyHandleDrag(drag.start, drag.handle, mm.xMm - drag.grab.xMm, mm.yMm - drag.grab.yMm, MIN_VP_MM);
        last = drag.handle === "body" ? clampRectToSheet(r, sheet.w, sheet.h) : r;
      }
      setPreview({ drag, rect: last });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setPreview(null);
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
      setTableDrag({ id: table.id, ...last });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setTableDrag(null);
      if (last.dx === 0 && last.dy === 0) return;
      handlers.onPatchTable(table.id, { xMm: round1(table.xMm + last.dx), yMm: round1(table.yMm + last.dy) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
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
        {master && (
          <g pointerEvents="none">
            <TitleBlockSvg sheet={sheet} tb={titleBlock} paper={layout.paper} orientation={layout.orientation} />
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
      // Tabelle zuerst (liegt über den Viewports), dann Viewport.
      const tableHit = [...tables].reverse().find((tb) => {
        const src = layoutTables.find((x) => x.id === tb.id);
        return src && mm.xMm >= src.xMm && mm.xMm <= src.xMm + tb.widthMm && mm.yMm >= src.yMm && mm.yMm <= src.yMm + Math.max(tb.heightMm, 4);
      });
      setSelectedTableId(tableHit ? tableHit.id : null);
      const hit = tableHit ? null : pickViewport(layout.viewports, mm.xMm, mm.yMm, 0);
      setSelectedId(hit ? hit.id : null);
    } else {
      setSelectedId(null);
      setSelectedTableId(null);
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
        <span style={{ flex: 1 }} />
        <button className="nav-add" onClick={() => planViewRef.current?.fit()} title={t("layouts.fit")}>
          {t("layouts.fit")}
        </button>
      </div>

      <div className="layout-sheet-stage">
        {children({ backdrop, fitBounds, onPlanSelect: onSheetSelect })}

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
