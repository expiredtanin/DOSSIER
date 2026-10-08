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
// egal ob der Plan 1:50 oder 1:200 steht.

import type { EndMark, Vec2 } from "../../model/types";
import { mmToModel } from "../../model/dimension";
import type { Primitive } from "./shared";
import { NO_HATCH } from "./shared";

/** Default-Grösse der Linienenden in Papier-Millimetern. */
export const END_MARK_DEFAULT_SIZE_MM = 3;

/** Öffnungsverhältnis der Pfeilspitze (halbe Breite ÷ Länge) — schlanke Spitze. */
const ARROW_ASPECT = 0.32;

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
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-9) return 0;
  const size = mmToModel(sizeMm, scaleDenominator);
  const ux = dir.x / len;
  const uy = dir.y / len;
  const nx = -uy;
  const ny = ux;
  const { weightMm, color, greyed, drawingId } = style;

  /** Fusspunkt der Spitze (size zurück entlang der Linie). */
  const base: Vec2 = { x: at.x - ux * size, y: at.y - uy * size };
  const half = size * ARROW_ASPECT;
  const wingA: Vec2 = { x: base.x + nx * half, y: base.y + ny * half };
  const wingB: Vec2 = { x: base.x - nx * half, y: base.y - ny * half };
  const line = (a: Vec2, b: Vec2) =>
    out.push({ kind: "line", a, b, cls: "draw2d", weightMm, dash: null, color, greyed, drawingId });

  switch (mark) {
    case "arrow":
      out.push({
        kind: "polygon",
        pts: [at, wingA, wingB],
        fill: color,
        stroke: color,
        strokeWidthMm: weightMm,
        hatch: NO_HATCH,
        greyed,
        drawingId,
      });
      // Die gefüllte Spitze überdeckt die Linie — dort darf sie enden.
      return size;
    case "arrowOpen":
      line(wingA, at);
      line(wingB, at);
      // Offene Spitze: die Linie läuft bis zum Punkt durch (sie ist Teil des Bildes).
      return 0;
    case "dot":
      out.push({
        kind: "drawingCircle",
        center: at,
        r: size * 0.25,
        fill: color,
        stroke: color,
        weightMm,
        greyed,
        drawingId,
      });
      return 0;
    case "tick": {
      // 45°-Schrägstrich, mittig auf dem Endpunkt (SIA-Massstrich-Anmutung).
      const tx = (ux + nx) / Math.SQRT2;
      const ty = (uy + ny) / Math.SQRT2;
      const h = size / 2;
      line({ x: at.x - tx * h, y: at.y - ty * h }, { x: at.x + tx * h, y: at.y + ty * h });
      return 0;
    }
    case "square": {
      const h = size * 0.3;
      out.push({
        kind: "polygon",
        pts: [
          { x: at.x + (ux + nx) * h, y: at.y + (uy + ny) * h },
          { x: at.x + (ux - nx) * h, y: at.y + (uy - ny) * h },
          { x: at.x + (-ux - nx) * h, y: at.y + (-uy - ny) * h },
          { x: at.x + (-ux + nx) * h, y: at.y + (-uy + ny) * h },
        ],
        fill: color,
        stroke: color,
        strokeWidthMm: weightMm,
        hatch: NO_HATCH,
        greyed,
        drawingId,
      });
      return 0;
    }
  }
}

/** Punkt `p` um `d` in Richtung `dir` (normiert) zurückgezogen — für die Linienverkürzung. */
export function pullBack(p: Vec2, dir: Vec2, d: number): Vec2 {
  if (d <= 0) return p;
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-9) return p;
  return { x: p.x - (dir.x / len) * d, y: p.y - (dir.y / len) * d };
}
