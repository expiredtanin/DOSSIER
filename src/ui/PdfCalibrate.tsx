// Zwei-Punkt-Kalibrierung im PDF-Import-Dialog ([76]): Vorschau der gelesenen Pfade auf einem Canvas,
// zwei Punkte anklicken (Fang an Pfadpunkten, Kreismitten, Quadranten), wahre Länge eingeben → Massstab.
// Rechnung und Fangindex: `io/pdfCalibrate.ts`. Mausrad zoomt um den Zeiger, Ziehen verschiebt.

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import type { PdfVectorPage } from "../io/pdfVector";
import { buildSnapIndex, formatScale, pdfPaperMm, pdfScaleFromDistance } from "../io/pdfCalibrate";
import type { Pt } from "../io/pdfCalibrate";

const HEIGHT = 280;
const SNAP_PX = 10;
const DRAG_PX = 4;

interface View {
  /** Seitenpunkt (pt) in der Mitte der Fläche. */
  cx: number;
  cy: number;
  /** Bildschirm-Pixel je pt. */
  zoom: number;
}

/** Fast weisse Striche auf dem Papier-Hintergrund sichtbar halten. */
function visibleStroke(c: string): string {
  const v = parseInt(c.slice(1), 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  return r + g + b > 690 ? "#b8b8b8" : c;
}

interface Layers {
  strokes: [string, Path2D][];
  fills: [string, Path2D][];
}

function buildLayers(page: PdfVectorPage): Layers {
  const strokes = new Map<string, Path2D>();
  const fills = new Map<string, Path2D>();
  const trace = (path: Path2D, pts: { x: number; y: number }[], closed: boolean) => {
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    if (closed) path.closePath();
  };
  for (const p of page.paths) {
    if (p.pts.length < 2) continue;
    if (p.fill && p.closed) {
      // Weisse Seitenhintergründe nicht über die Linien malen.
      if (p.fill === "#ffffff") continue;
      const g = fills.get(p.fill) ?? new Path2D();
      fills.set(p.fill, g);
      trace(g, p.pts, true);
    }
    if (p.stroke) {
      const c = visibleStroke(p.stroke);
      const g = strokes.get(c) ?? new Path2D();
      strokes.set(c, g);
      trace(g, p.pts, p.closed);
    }
  }
  return { strokes: [...strokes], fills: [...fills] };
}

function fitView(page: PdfVectorPage, w: number): View {
  const zoom = Math.min(w / page.width, HEIGHT / page.height) * 0.96;
  return { cx: page.width / 2, cy: page.height / 2, zoom: Math.max(zoom, 1e-6) };
}

export interface PdfCalibrateProps {
  page: PdfVectorPage;
  /** Berechnete Massstabszahl übernehmen. */
  onApply: (scale: number) => void;
}

export function PdfCalibrate({ page, onApply }: PdfCalibrateProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(480);
  const [view, setView] = useState<View>(() => fitView(page, 480));
  const [pts, setPts] = useState<Pt[]>([]);
  const [hover, setHover] = useState<{ p: Pt; snapped: boolean } | null>(null);
  const [lenText, setLenText] = useState("");
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);

  const layers = useMemo(() => buildLayers(page), [page]);
  const index = useMemo(() => buildSnapIndex(page), [page]);

  // Breite der Fläche folgen; beim ersten Mass die Seite einpassen.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const w = Math.max(200, Math.floor(el.clientWidth));
      setWidth((old) => {
        if (old !== w) setView(fitView(page, w));
        return w;
      });
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page]);

  // Neue Seite: Messung und Ansicht zurücksetzen.
  useEffect(() => {
    setPts([]);
    setHover(null);
    setView(fitView(page, width));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const toPage = (sx: number, sy: number): Pt => ({
    x: view.cx + (sx - width / 2) / view.zoom,
    y: view.cy - (sy - HEIGHT / 2) / view.zoom,
  });
  const toScreen = (p: Pt): [number, number] => [width / 2 + (p.x - view.cx) * view.zoom, HEIGHT / 2 - (p.y - view.cy) * view.zoom];

  // Zeichnen.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const css = getComputedStyle(canvas);
    const accent = css.getPropertyValue("--accent").trim() || "#c2410c";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css.getPropertyValue("--panel-2").trim() || "#d4cfc8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Seitenraum: y nach oben.
    ctx.setTransform(dpr * view.zoom, 0, 0, -dpr * view.zoom, dpr * (width / 2 - view.cx * view.zoom), dpr * (HEIGHT / 2 + view.cy * view.zoom));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, page.width, page.height);
    ctx.globalAlpha = 0.3;
    for (const [c, path] of layers.fills) {
      ctx.fillStyle = c;
      ctx.fill(path);
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1 / view.zoom;
    ctx.lineJoin = "round";
    for (const [c, path] of layers.strokes) {
      ctx.strokeStyle = c;
      ctx.stroke(path);
    }
    // Messung im Bildschirmraum.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    if (pts.length === 2) {
      const [x0, y0] = toScreen(pts[0]);
      const [x1, y1] = toScreen(pts[1]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    for (const p of pts) {
      const [x, y] = toScreen(p);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (hover && pts.length < 2) {
      const [x, y] = toScreen(hover.p);
      ctx.strokeStyle = hover.snapped ? "#16a34a" : accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 5, y - 5, 10, 10);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, layers, view, pts, hover, width]);

  // Mausrad zoomt um den Zeiger (nicht-passiver Listener, damit die Seite nicht mitscrollt).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      setView((v) => {
        const f = Math.exp(-e.deltaY * 0.0015);
        const fit = fitView(page, width).zoom;
        const zoom = Math.min(fit * 600, Math.max(fit * 0.5, v.zoom * f));
        // Der Seitenpunkt unter dem Zeiger bleibt stehen.
        const px = v.cx + (sx - width / 2) / v.zoom;
        const py = v.cy - (sy - HEIGHT / 2) / v.zoom;
        return { zoom, cx: px - (sx - width / 2) / zoom, cy: py + (sy - HEIGHT / 2) / zoom };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [page, width]);

  const local = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const pickAt = (sx: number, sy: number) => {
    const raw = toPage(sx, sy);
    const snap = index.nearest(raw.x, raw.y, SNAP_PX / view.zoom);
    return { p: snap ?? raw, snapped: snap !== null };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { sx, sy } = local(e);
    drag.current = { x: sx, y: sy, view, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { sx, sy } = local(e);
    const d = drag.current;
    if (d) {
      const dx = sx - d.x;
      const dy = sy - d.y;
      if (d.moved || Math.hypot(dx, dy) > DRAG_PX) {
        d.moved = true;
        setView({ zoom: d.view.zoom, cx: d.view.cx - dx / d.view.zoom, cy: d.view.cy + dy / d.view.zoom });
        return;
      }
    }
    setHover(pickAt(sx, sy));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const { sx, sy } = local(e);
    const { p } = pickAt(sx, sy);
    // Dritter Klick beginnt eine neue Messung.
    setPts((old) => (old.length >= 2 ? [p] : [...old, p]));
  };

  const trueLen = Number(lenText.trim().replace(",", "."));
  const scale = pts.length === 2 ? pdfScaleFromDistance(pts[0], pts[1], trueLen) : null;
  const status =
    pts.length === 0 ? t("import.pdf.cal.pick1") : pts.length === 1 ? t("import.pdf.cal.pick2") : null;

  return (
    <div className="imp-cal" ref={wrapRef}>
      <div className="imp-note">{t("import.pdf.cal.hint")}</div>
      <canvas
        ref={canvasRef}
        className="imp-cal-canvas"
        style={{ width: "100%", height: HEIGHT }}
        role="img"
        aria-label={t("import.pdf.cal.canvas")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHover(null);
          drag.current = null;
        }}
      />
      <div className="imp-cal-row">
        {status && <span className="imp-note">{status}</span>}
        {pts.length === 2 && (
          <span className="imp-note">{t("import.pdf.cal.measured", { mm: pdfPaperMm(pts[0], pts[1]).toFixed(1) })}</span>
        )}
        <button className="imp-btn imp-cal-small" onClick={() => setView(fitView(page, width))}>
          {t("import.pdf.cal.fit")}
        </button>
        {pts.length > 0 && (
          <button className="imp-btn imp-cal-small" onClick={() => setPts([])}>
            {t("import.pdf.cal.reset")}
          </button>
        )}
      </div>
      {pts.length === 2 && (
        <div className="imp-cal-row">
          <input
            className="imp-input imp-cal-len"
            type="text"
            inputMode="decimal"
            placeholder={t("import.pdf.cal.trueLength")}
            aria-label={t("import.pdf.cal.trueLength")}
            value={lenText}
            onChange={(e) => setLenText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && scale) onApply(Math.round(scale * 100) / 100);
            }}
            autoFocus
          />
          {scale && <span className="imp-note">{t("import.pdf.cal.result", { scale: formatScale(scale) })}</span>}
          <button
            className="imp-btn primary imp-cal-small"
            disabled={!scale}
            onClick={() => scale && onApply(Math.round(scale * 100) / 100)}
          >
            {t("import.pdf.cal.apply")}
          </button>
        </div>
      )}
    </div>
  );
}
