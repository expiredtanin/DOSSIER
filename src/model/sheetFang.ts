// Objektfang auf dem Layout-Blatt ([208]): Papierrand, Hilfslinien des Masters und die Rahmen der Blatt-Elemente
// (Viewports, Bilder, Tabellen mit fester Höhe) als Fangstrecken der Blatt-Ebene. Die Textspalte (und jedes andere
// Zeichenwerkzeug der Blatt-Ebene) fängt damit an Blattrand, Hilfslinien und anderen Elementen — Endpunkt, Mitte,
// Kante und Schnitt wie überall (`tools/snapping.ts` liest `sheetSnapSegments`). Die Strecken liegen in Modell-
// Metern der Blatt-Ebene (Papier-mm ↔ Meter: `sheetMmToModel`).

import type { Layout, LayoutGuide, Vec2 } from "./types";
import { sheetMmToModel } from "./layoutModel";
/** Strecke wie `SnapSeg` (tools/sheetSnapGeometry; der Kern importiert `tools` nicht). */
type SnapSeg = [Vec2, Vec2];

type RectMm = { xMm: number; yMm: number; widthMm: number; heightMm: number };

function rectSegs(r: RectMm): SnapSeg[] {
  const a = sheetMmToModel(r.xMm, r.yMm);
  const b = sheetMmToModel(r.xMm + r.widthMm, r.yMm);
  const c = sheetMmToModel(r.xMm + r.widthMm, r.yMm + r.heightMm);
  const d = sheetMmToModel(r.xMm, r.yMm + r.heightMm);
  return [
    [a, b],
    [b, c],
    [c, d],
    [d, a],
  ];
}

/** Hilfslinie als Strecke über die ganze Blattbreite/-höhe. */
export function guideSeg(g: LayoutGuide, sheetW: number, sheetH: number): SnapSeg {
  return g.axis === "x"
    ? [sheetMmToModel(g.posMm, 0), sheetMmToModel(g.posMm, sheetH)]
    : [sheetMmToModel(0, g.posMm), sheetMmToModel(sheetW, g.posMm)];
}

/**
 * Fangstrecken des Blatts `layout` (Grösse `sheet` in mm, `guides` = Hilfslinien des Masters). Leere Rahmen und
 * Hilfslinien ohne endliche Lage fallen weg.
 */
export function sheetFangSegments(layout: Layout, sheet: { w: number; h: number }, guides: readonly LayoutGuide[] = []): SnapSeg[] {
  const out: SnapSeg[] = rectSegs({ xMm: 0, yMm: 0, widthMm: sheet.w, heightMm: sheet.h });
  for (const g of guides) if (Number.isFinite(g.posMm)) out.push(guideSeg(g, sheet.w, sheet.h));
  const frames: RectMm[] = [
    ...layout.viewports,
    ...(layout.images ?? []),
    ...(layout.tables ?? []).flatMap((t) => (t.heightMm && t.heightMm > 0 ? [{ ...t, heightMm: t.heightMm }] : [])),
  ];
  for (const r of frames) {
    if (![r.xMm, r.yMm, r.widthMm, r.heightMm].every(Number.isFinite) || r.widthMm <= 0 || r.heightMm <= 0) continue;
    out.push(...rectSegs(r));
  }
  return out;
}
