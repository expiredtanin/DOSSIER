// Flacht einen {@link Plan} (die eine Wahrheit aus generatePlan) auf das
// GPU-nahe Szenenformat des nativen render2d-Renderers ab: Füllpolygone,
// Umrisse und Linien. Hatch und Text bleiben (wie im Rust-Renderer, siehe
// render2d/src/types.rs) vorerst außen vor — sie sind Overlay/späteres M3.
//
// Das erzeugte Objekt matcht 1:1 die serde-Structs render2d::types::Scene
// { fills:[{pts,color}], outlines:[{pts,color,widthMm}], lines:[{a,b,color,widthMm}] }
// mit Point = [x,y] (Meter) und Rgba = [r,g,b,a] (0..1).

import type { Plan, Primitive } from "./generatePlan";
import { applyDashRuns, buildHatchRuns } from "./glPlan/glPlanHatch";
import { CAP, layoutLine } from "./strokeFont";

type LinePrim = Extract<Primitive, { kind: "line" }>;

/** Modell-Meter pro Schriftpunkt (Referenz-Massstab 1:100, wie im SVG-Pfad). */
const METERS_PER_PT = (1 / 72) * 0.0254 * 100;
/** Strichbreite der Text-Glyphen in Papier-mm (Haarlinie). */
const TEXT_WIDTH_MM = 0.15;

export type RPoint = [number, number];
export type RRgba = [number, number, number, number];

export interface RFill {
  pts: RPoint[];
  color: RRgba;
}
export interface ROutline {
  pts: RPoint[];
  color: RRgba;
  widthMm: number;
}
export interface RPolyline {
  pts: RPoint[];
  color: RRgba;
  widthMm: number;
}
export interface RLine {
  a: RPoint;
  b: RPoint;
  color: RRgba;
  widthMm: number;
}
export interface RScene {
  fills: RFill[];
  outlines: ROutline[];
  polylines: RPolyline[];
  lines: RLine[];
}

const DEFAULT_LINE = "#1a1a1a";

/** Wenige benannte Farben, die in Klassen/Defaults vorkommen können. */
const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  none: "none",
  transparent: "none",
};

/** Hex/Named-Farbe → [r,g,b,a] in 0..1, oder null bei "none"/leer. */
function toRgba(input: string | undefined, alpha = 1): RRgba | null {
  if (!input) return null;
  let h = input.trim().toLowerCase();
  if (h === "none" || h === "transparent") return null;
  if (h[0] !== "#") {
    const mapped = NAMED[h];
    if (!mapped) return [0, 0, 0, alpha];
    if (mapped === "none") return null;
    h = mapped;
  }
  h = h.slice(1);
  // Kurzformen auf Langform expandieren (#rgb → #rrggbb, #rgba → #rrggbbaa).
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return [0, 0, 0, alpha];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  // 8-stelliges Hex trägt den Alpha-Kanal selbst; sonst der Parameter.
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : alpha;
  if (![r, g, b, a].every((v) => Number.isFinite(v))) return [0, 0, 0, alpha];
  return [r, g, b, a];
}

/** Kreisbogen in Liniensegmente zerlegen (kürzerer Sweep, ~24 Segmente). */
function tessellateArc(
  center: { x: number; y: number },
  from: { x: number; y: number },
  to: { x: number; y: number },
  r: number,
): RPoint[] {
  const a0 = Math.atan2(from.y - center.y, from.x - center.x);
  let a1 = Math.atan2(to.y - center.y, to.x - center.x);
  // Kürzeren Bogen wählen (generatePlan liefert keine largeArc-Info mit).
  let delta = a1 - a0;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  a1 = a0 + delta;
  const segs = Math.max(2, Math.ceil((Math.abs(delta) / (Math.PI * 2)) * 48));
  const pts: RPoint[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = a0 + (delta * i) / segs;
    pts.push([center.x + Math.cos(t) * r, center.y + Math.sin(t) * r]);
  }
  return pts;
}

/** Zwei Modell-Punkte (Meter) als gleich behandeln (Verkettungs-Toleranz). */
function samePt(a: RPoint, b: RPoint): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

/** Gleicher Linienstil (für das Verketten aufeinanderfolgender 2D-Zeichenlinien). */
function sameLineStyle(a: LinePrim, b: LinePrim): boolean {
  return (
    a.cls === b.cls &&
    a.weightMm === b.weightMm &&
    (a.color ?? "") === (b.color ?? "") &&
    JSON.stringify(a.dash ?? null) === JSON.stringify(b.dash ?? null)
  );
}

/**
 * Zerlegt einen Polygon-Ring in zusammenhängende Läufe SICHTBARER Kanten (die
 * `noStroke`-Kanten werden ausgelassen). Jeder Lauf beginnt an einer sichtbaren
 * Kante, deren Vorgänger unterdrückt ist. Portiert aus PlanView.visibleEdgeRuns —
 * so bekommen die inneren Ecken eine Gehrung statt Stumpfkappen.
 */
function visibleEdgeRuns(pts: RPoint[], noStroke: number[]): RPoint[][] {
  const n = pts.length;
  const skip = new Set(noStroke.map((i) => ((i % n) + n) % n));
  if (skip.size >= n || n < 2) return [];
  const visible = (i: number) => !skip.has(((i % n) + n) % n);
  const runs: RPoint[][] = [];
  for (let s = 0; s < n; s++) {
    if (!visible(s) || visible(s - 1 + n)) continue; // kein Lauf-Anfang
    const run: RPoint[] = [pts[s]];
    let j = s;
    while (visible(j) && j - s < n) {
      run.push(pts[(j + 1) % n]);
      j++;
    }
    runs.push(run);
  }
  return runs;
}

/**
 * Wandelt einen Plan in eine native render2d-Szene um. Zusammenhängende Umriss-
 * und Zeichnungskanten werden zu OFFENEN Polylinien verkettet (gehrte Ecken);
 * nur genuin einzelne Segmente (Türblätter, Referenzlinien) bleiben `lines`.
 */
export function planToRenderScene(plan: Plan): RScene {
  const fills: RFill[] = [];
  const outlines: ROutline[] = [];
  const polylines: RPolyline[] = [];
  const lines: RLine[] = [];

  // Laufender, verketteter 2D-Zeichnungs-Zug (gleiche drawingId + Stil, End-an-Start).
  let curPts: RPoint[] | null = null;
  let curSrc: LinePrim | null = null;
  const flushRun = () => {
    if (curPts && curSrc && curPts.length >= 2) {
      const col = toRgba(curSrc.color ?? DEFAULT_LINE, 1) ?? [0.1, 0.1, 0.1, 1];
      const closed = curPts.length > 2 && samePt(curPts[0], curPts[curPts.length - 1]);
      if (closed) {
        outlines.push({ pts: curPts.slice(0, -1), color: col, widthMm: curSrc.weightMm });
      } else {
        polylines.push({ pts: curPts, color: col, widthMm: curSrc.weightMm });
      }
    }
    curPts = null;
    curSrc = null;
  };

  for (const p of plan.primitives) {
    if (p.kind === "polygon") {
      flushRun();
      const pts: RPoint[] = p.pts.map((v) => [v.x, v.y]);
      if (pts.length < 2) continue;

      // Füllung
      const fillCol = toRgba(p.fill, 1);
      if (fillCol && pts.length >= 3) fills.push({ pts, color: fillCol });

      // Schraffur: die aufs Polygon geclippten Musterlinien wie im Browser
      // (glPlanHatch — identische Geometrie), als Polylinien. "none"/"solid"
      // brauchen keine Linien (solid deckt die Füllung farbig ab).
      if (p.hatch && p.hatch.pattern !== "none" && p.hatch.pattern !== "solid") {
        const hatchCol = toRgba(p.hatch.color, 1) ?? [0.1, 0.1, 0.1, 1];
        const hatchMm = p.hatch.lineWeight > 0 ? p.hatch.lineWeight : 0.13;
        const runs = applyDashRuns(buildHatchRuns(p.pts, p.hatch), p.hatch.dash);
        for (const run of runs) {
          if (run.length >= 2) {
            polylines.push({ pts: run.map((v) => [v.x, v.y]), color: hatchCol, widthMm: hatchMm });
          }
        }
      }

      // Umriss
      const strokeCol = toRgba(p.stroke, 1);
      if (strokeCol && p.strokeWidthMm > 0) {
        const suppressed = p.noStrokeEdges ?? [];
        if (suppressed.length === 0) {
          // Ganzer Ring → geschlossener, gehrter Umriss.
          outlines.push({ pts, color: strokeCol, widthMm: p.strokeWidthMm });
        } else {
          // Nur die sichtbaren Kanten, als zusammenhängende (offene) Läufe.
          for (const run of visibleEdgeRuns(pts, suppressed)) {
            polylines.push({ pts: run, color: strokeCol, widthMm: p.strokeWidthMm });
          }
        }
      }
    } else if (p.kind === "line") {
      if (p.drawingId) {
        // Aufeinanderfolgende 2D-Zeichenlinien gleicher drawingId/Stil verketten.
        const a: RPoint = [p.a.x, p.a.y];
        const b: RPoint = [p.b.x, p.b.y];
        if (curPts && curSrc && sameLineStyle(curSrc, p) && samePt(curPts[curPts.length - 1], a)) {
          curPts.push(b);
        } else {
          flushRun();
          curPts = [a, b];
          curSrc = p;
        }
      } else {
        // Genuin einzelnes Segment (Türblatt, Referenzlinie, Symbol) → Stumpfkappen ok.
        flushRun();
        const col = toRgba(p.color ?? DEFAULT_LINE, 1) ?? [0.1, 0.1, 0.1, 1];
        lines.push({ a: [p.a.x, p.a.y], b: [p.b.x, p.b.y], color: col, widthMm: p.weightMm });
      }
    } else if (p.kind === "arc") {
      flushRun();
      const col = toRgba(DEFAULT_LINE, 1) ?? [0.1, 0.1, 0.1, 1];
      // Bogen als EINE zusammenhängende Polylinie (gehrte Sehnen-Ecken).
      const poly = tessellateArc(p.center, p.from, p.to, p.r);
      if (poly.length >= 2) polylines.push({ pts: poly, color: col, widthMm: p.weightMm });
    } else if (p.kind === "text") {
      flushRun();
      // Raumstempel: Doc-Zeilen + Live-Zusatzzeilen als Einstrich-Glyph-Polylinien
      // (Modell-Meter, vertikal um den Anker zentriert). Erste Fassung: Versalien.
      const col = toRgba(p.color, 1) ?? [0.1, 0.1, 0.1, 1];
      const docLines = p.doc.paragraphs.map((par) => ({
        text: par.runs.map((r) => r.text).join(""),
        align: par.align ?? "left",
        sizePt: p.basePt,
      }));
      const extraLines = p.extraLines.map((t) => ({
        text: t,
        align: "center" as const,
        sizePt: p.basePt * 0.8,
      }));
      const allLines = [...docLines, ...extraLines].filter((l) => l.text.length > 0);
      if (allLines.length > 0) {
        const gaps = allLines.map((l) => l.sizePt * METERS_PER_PT * 1.3);
        const totalH = gaps.reduce((a, b) => a + b, 0);
        let cursorY = p.at.y + totalH / 2;
        allLines.forEach((line, i) => {
          const scale = (line.sizePt * METERS_PER_PT * 0.7) / CAP;
          cursorY -= gaps[i];
          const baseY = cursorY;
          const { strokes, width } = layoutLine(line.text);
          const wModel = width * scale;
          const startX =
            line.align === "center"
              ? p.at.x - wModel / 2
              : line.align === "right"
              ? p.at.x - wModel
              : p.at.x;
          for (const s of strokes) {
            if (s.length < 2) continue;
            polylines.push({
              pts: s.map(([x, y]) => [startX + x * scale, baseY + y * scale] as RPoint),
              color: col,
              widthMm: TEXT_WIDTH_MM,
            });
          }
        });
      }
    } else {
      flushRun();
    }
  }
  flushRun();

  return { fills, outlines, polylines, lines };
}
