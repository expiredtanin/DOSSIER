// Wiederverwendbarer Mini-Editor für ein loopendes Wiederhol-Motiv: eine OFFENE
// Polylinie in einer Einheitszelle (`x` 0..length entlang der Linie, `y` quer zur
// Achse). Der Nutzer setzt Punkte (Klick auf die freie Fläche), zieht sie (Drag)
// und entfernt sie (Doppelklick). Eine Live-Vorschau kachelt 2–3 Wiederholungen.
//
// Bewusst GENERISCH gehalten (Props = Punkte + Länge + onChange): derselbe Editor
// dient später auch einem Schraffur-Kachel-Motiv. Rein zeichenflächen-lokal, KEIN
// Rückgriff auf die Plan-Renderer — die Kachelung wird für die Vorschau lokal
// nachgebaut (deckungsgleich zur `motifPoints`-Kachelung im Renderer).
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useRef, useState } from "react";
import type { Vec2 } from "../model/types";
import { t } from "../i18n";

/** Motiv (offene Polylinie in einer Einheitszelle). Einheit: mm Papier. */
export interface Motif {
  points: Vec2[];
  length: number;
}

/** Zeichenflächen-Geometrie (px). */
const PLOT_W = 260;
const PLOT_H = 120;
const PAD = 10;
const INNER_W = PLOT_W - 2 * PAD;
const INNER_H = PLOT_H - 2 * PAD;
const MID_Y = PLOT_H / 2;

/** Halbe vertikale Spanne (mm) der Zeichenfläche, mind. 2 mm, sonst aus Daten. */
function yRangeOf(points: Vec2[]): number {
  let m = 2;
  for (const p of points) m = Math.max(m, Math.abs(p.y) + 0.5);
  return m;
}

/**
 * Editor für ein Wiederhol-Motiv. `points`/`length` in mm Papier; `onChange`
 * liefert die neue Punktliste UND die (ggf. per Feld geänderte) Länge zurück.
 */
export function MotifEditor({
  points,
  length,
  onChange,
}: {
  points: Vec2[];
  length: number;
  onChange: (points: Vec2[], length: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const len = length > 0.01 ? length : 4;
  const yRange = yRangeOf(points);

  // ── Koordinaten-Abbildung Modell (mm) ↔ Zeichenfläche (px) ─────────────────
  const toPx = (p: Vec2): Vec2 => ({
    x: PAD + (Math.max(0, Math.min(len, p.x)) / len) * INNER_W,
    y: MID_Y - (p.y / yRange) * (INNER_H / 2),
  });
  const toModel = (clientX: number, clientY: number): Vec2 => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * PLOT_W;
    const py = ((clientY - rect.top) / rect.height) * PLOT_H;
    const x = ((px - PAD) / INNER_W) * len;
    const y = ((MID_Y - py) / (INNER_H / 2)) * yRange;
    return {
      x: Math.max(0, Math.min(len, Math.round(x * 20) / 20)),
      y: Math.max(-yRange, Math.min(yRange, Math.round(y * 20) / 20)),
    };
  };

  /** Punkte nach x sortiert halten → die Polylinie läuft stets links→rechts. */
  const sortByX = (list: Vec2[]): Vec2[] => [...list].sort((a, b) => a.x - b.x);

  const addPoint = (e: React.PointerEvent) => {
    if (drag != null) return;
    const p = toModel(e.clientX, e.clientY);
    onChange(sortByX([...points, p]), len);
  };

  const moveDragged = (e: React.PointerEvent) => {
    if (drag == null) return;
    const p = toModel(e.clientX, e.clientY);
    const next = points.slice();
    next[drag] = p;
    onChange(next, len);
  };

  const removePoint = (i: number) => {
    if (points.length <= 2) return; // mind. 2 Punkte (offene Linie)
    onChange(points.filter((_, k) => k !== i), len);
  };

  const pxPts = points.map(toPx);
  const polyStr = pxPts.map((s) => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(" ");

  // Raster-Linien (nur optische Hilfe): senkrecht bei 1/4-Schritten, Mittelachse.
  const gridX = [0.25, 0.5, 0.75].map((f) => PAD + f * INNER_W);

  return (
    <div className="motif-editor">
      <svg
        ref={svgRef}
        className="motif-canvas"
        width={PLOT_W}
        height={PLOT_H}
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        onPointerDown={addPoint}
        onPointerMove={moveDragged}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {/* Zellen-Rahmen */}
        <rect
          x={PAD}
          y={PAD}
          width={INNER_W}
          height={INNER_H}
          className="motif-frame"
        />
        {/* Raster */}
        {gridX.map((x, i) => (
          <line key={i} x1={x} y1={PAD} x2={x} y2={PLOT_H - PAD} className="motif-grid" />
        ))}
        <line x1={PAD} y1={MID_Y} x2={PLOT_W - PAD} y2={MID_Y} className="motif-axis" />
        {/* Motiv-Polylinie */}
        <polyline points={polyStr} className="motif-path" fill="none" />
        {/* Punkt-Griffe */}
        {pxPts.map((s, i) => (
          <circle
            key={i}
            cx={s.x}
            cy={s.y}
            r={5}
            className={`motif-handle${drag === i ? " is-drag" : ""}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setDrag(i);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              removePoint(i);
            }}
          />
        ))}
      </svg>

      <div className="motif-controls">
        <label className="motif-len">
          <span>{t("resources.motif.length")}</span>
          <input
            type="number"
            className="res-input"
            value={len}
            step={0.5}
            min={0.5}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) onChange(points, Math.max(0.5, v));
            }}
          />
        </label>
        <span className="motif-hint">{t("resources.motif.hint")}</span>
      </div>

      <MotifTilePreview points={points} length={len} yRange={yRange} />
    </div>
  );
}

/**
 * Live-Vorschau: kachelt das Motiv ~3× horizontal (deckungsgleich zur
 * `motifPoints`-Kachelung: Zelle [0,length] wird alle `length` wiederholt). Rein
 * schematisch (px); zeigt, wie der Loop entlang einer Linie aussieht.
 */
function MotifTilePreview({
  points,
  length,
  yRange,
}: {
  points: Vec2[];
  length: number;
  yRange: number;
}) {
  const W = PLOT_W;
  const H = 44;
  const mid = H / 2;
  const reps = 3;
  const pxPerMm = W / (reps * length);
  const ampPx = (H / 2 - 4) / yRange;
  const pts: string[] = [];
  if (points.length >= 2 && length > 0.01) {
    // Zellen aneinanderreihen; Naht-Duplikate überspringen (wie motifPoints).
    let lastX = -1;
    let lastY = 0;
    for (let r = 0; r < reps; r++) {
      const base = r * length;
      for (const p of points) {
        const x = (base + p.x) * pxPerMm;
        const y = mid - p.y * ampPx;
        if (x > W + 0.5) break;
        if (Math.abs(x - lastX) < 0.01 && Math.abs(y - lastY) < 0.01) continue;
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        lastX = x;
        lastY = y;
      }
    }
  }
  return (
    <svg className="motif-preview" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <line x1={0} y1={mid} x2={W} y2={mid} className="motif-axis" />
      {pts.length >= 2 && (
        <polyline points={pts.join(" ")} className="motif-path" fill="none" />
      )}
    </svg>
  );
}
