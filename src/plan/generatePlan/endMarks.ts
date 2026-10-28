// Linienenden (Pfeilspitze, Punkt, Schrägstrich, Quadrat) für OFFENE 2D-Formen
// und die Text-Hinweislinie — eine Objekteigenschaft, wie sie jedes CAD kennt.
//
// Zwei Dinge, die der Aufrufer liefern muss: den Endpunkt UND die auswärts
// zeigende Tangentenrichtung dort. Die Richtung ist je Form unterschiedlich
// herzuleiten (Sehne, Bogentangente, erstes/letztes Stützpunktpaar), steht
// deshalb NICHT hier — diese Datei erzeugt nur die Geometrie.
//
// Die Grösse kommt in PAPIER-MILLIMETERN herein und wird mit dem Massstab des
// Plans in Modellmass umgerechnet (gleiche Linie wie die Bemassung, s.
// `model/dimension.ts`): eine 3-mm-Pfeilspitze soll auf dem Papier 3 mm sein,
// egal ob der Plan 1:50 oder 1:200 steht. Die Geometrie berechnet der Rust-Kern (`plan_misc.rs`, [K3a]).

import type { EndMark, Vec2 } from "../../model/types";
import { core } from "../../engine/coreWasm";
import type { Primitive } from "./shared";
import { NO_HATCH } from "./shared";

/** Default-Grösse der Linienenden in Papier-Millimetern. */
export const END_MARK_DEFAULT_SIZE_MM = 3;

/** Kodierung der Linienenden im Kern (`plan_misc.rs`). */
const MARK_CODE: Record<Exclude<EndMark, "none">, number> = { arrow: 1, arrowOpen: 2, dot: 3, tick: 4, square: 5 };

export interface EndMarkStyle {
  weightMm: number;
  color: string;
  greyed: boolean;
  drawingId: string;
}

/**
 * Zeichnet EIN Linienende an `at`. `dir` zeigt AUSWÄRTS (aus der Form heraus)
 * und muss nicht normiert sein. `sizeMm` ist Papier-mm, `scaleDenominator` der
 * Massstab des Plans.
 *
 * Liefert zusätzlich, um wie viel die Linie an diesem Ende VERKÜRZT werden
 * sollte, damit sie nicht unter der Spitze hervorsteht (0, wo das Ende die
 * Linie nicht überdeckt — Punkt/Schrägstrich/Quadrat sitzen mittig auf dem
 * Endpunkt).
 */
export function addEndMark(
  out: Primitive[],
  at: Vec2,
  dir: Vec2,
  mark: EndMark | undefined,
  sizeMm: number,
  scaleDenominator: number,
  style: EndMarkStyle,
): number {
  if (!mark || mark === "none") return 0;
  const f = core().end_mark_flat(at.x, at.y, dir.x, dir.y, MARK_CODE[mark], sizeMm, scaleDenominator);
  if (f.length === 0) return 0;
  const { weightMm, color, greyed, drawingId } = style;
  let i = 2;
  for (let k = 0; k < f[1]; k++) {
    if (f[i] === 1) {
      const count = f[i + 1];
      const pts = Array.from({ length: count }, (_, j) => ({ x: f[i + 2 + 2 * j], y: f[i + 3 + 2 * j] }));
      out.push({ kind: "polygon", pts, fill: color, stroke: color, strokeWidthMm: weightMm, hatch: NO_HATCH, greyed, drawingId });
      i += 2 + 2 * count;
    } else if (f[i] === 2) {
      out.push({
        kind: "line",
        a: { x: f[i + 1], y: f[i + 2] },
        b: { x: f[i + 3], y: f[i + 4] },
        cls: "draw2d",
        weightMm,
        dash: null,
        color,
        greyed,
        drawingId,
      });
      i += 5;
    } else {
      out.push({ kind: "drawingCircle", center: { x: f[i + 1], y: f[i + 2] }, r: f[i + 3], fill: color, stroke: color, weightMm, greyed, drawingId });
      i += 4;
    }
  }
  return f[0];
}

/** Punkt `p` um `d` in Richtung `dir` (normiert) zurückgezogen — für die Linienverkürzung. */
export function pullBack(p: Vec2, dir: Vec2, d: number): Vec2 {
  if (d <= 0) return p;
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-9) return p;
  return { x: p.x - (dir.x / len) * d, y: p.y - (dir.y / len) * d };
}
