// Vorschau-Formen eines (transformierten) 2D-Elements für Verschieben/Kopieren/
// Drehen/Spiegeln/Skalieren: das Element läuft durch DIESELBE Primitiv-Erzeugung
// wie der Plan (Kern, `drawingPrimitives`), die Primitive werden in einfache Vorschau-Formen
// (Linien/Polygone) übersetzt. So hat JEDE Form eine Vorschau — Kreis, Bogen,
// Spline, Text, Bemassung, Kote, Block, Polylinien-Bögen … (vorher nur Linie/
// Polylinie/Rechteck/Bild, alles andere war beim Verschieben unsichtbar).

import type { Drawing2D, Project, Vec2 } from "../model/types";
import type { Primitive } from "../core";
import { drawingPrimitives } from "../core";
import { textFrameCorners } from "../text/textFrame";
import type { DraftShape } from "./types";

/** Obergrenze je Element (Schraffur-Muster u. Ä. können sehr viele Linien erzeugen). */
const MAX_SHAPES_PER_ITEM = 4000;

function ringLines(center: Vec2, r: number, a0: number, a1: number, out: DraftShape[]): void {
  const sweep = a1 - a0;
  const n = Math.max(8, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * 48));
  let prev = { x: center.x + r * Math.cos(a0), y: center.y + r * Math.sin(a0) };
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    const p = { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
    out.push({ kind: "line", a: prev, b: p });
    prev = p;
  }
}

/** Plan-Primitive → Vorschau-Formen. */
export function primitivesToDraftShapes(prims: readonly Primitive[]): DraftShape[] {
  const out: DraftShape[] = [];
  for (const p of prims) {
    if (out.length >= MAX_SHAPES_PER_ITEM) break;
    switch (p.kind) {
      case "line":
        out.push({ kind: "line", a: p.a, b: p.b });
        break;
      case "polygon":
        if (p.pts.length >= 2) out.push({ kind: "poly", pts: p.pts, closed: true });
        break;
      case "drawingCircle":
        ringLines(p.center, p.r, 0, Math.PI * 2, out);
        break;
      case "drawingArc": {
        const TAU = Math.PI * 2;
        const sweep = (((p.a1 - p.a0) % TAU) + TAU) % TAU || TAU;
        ringLines(p.center, p.r, p.a0, p.a0 + sweep, out);
        break;
      }
      case "arc": {
        const a0 = Math.atan2(p.from.y - p.center.y, p.from.x - p.center.x);
        const a1 = Math.atan2(p.to.y - p.center.y, p.to.x - p.center.x);
        let d = a1 - a0;
        while (d <= -Math.PI) d += 2 * Math.PI;
        while (d > Math.PI) d -= 2 * Math.PI;
        const r = Math.hypot(p.from.x - p.center.x, p.from.y - p.center.y);
        ringLines(p.center, r, a0, a0 + d, out);
        break;
      }
      case "drawingText":
        out.push({ kind: "poly", pts: textFrameCorners(p), closed: true });
        break;
      case "drawingTextPath":
        for (let i = 0; i + 1 < p.pathPts.length; i++) out.push({ kind: "line", a: p.pathPts[i], b: p.pathPts[i + 1] });
        break;
      case "drawingImage":
        out.push({
          kind: "poly",
          pts: [p.min, { x: p.max.x, y: p.min.y }, p.max, { x: p.min.x, y: p.max.y }],
          closed: true,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Vorschau-Formen eines 2D-Elements (Geometrie bereits transformiert). */
export function drawingPreviewShapes(project: Project, d: Drawing2D, scaleDenominator?: number): DraftShape[] {
  let prims: Primitive[];
  try {
    prims = drawingPrimitives(project, d, scaleDenominator);
  } catch {
    return [];
  }
  return primitivesToDraftShapes(prims);
}
