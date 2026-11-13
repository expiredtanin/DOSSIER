// Blatt-Fang auf Hilfslinien und Bild-Zuschnitt durch Ziehen ([208]): reine Zahlen, kein React/DOM.
// Die Fang-Toleranz kommt in Papier-mm herein (das UI rechnet sie aus Bildschirm-Pixeln um).
//
// Bezeichner englisch, Kommentare deutsch.

import type { LayoutGuide } from "../model/types";
import type { Handle, RectMm } from "./layoutSheetMath";

/** Fang-Toleranz in Bildschirm-Pixeln (wie die Griffe: Pixel, nicht mm). */
export const SNAP_PX = 8;

/** Eine Hilfslinie, an der gerade gefangen wurde (für die Hervorhebung). */
export type GuideHit = { axis: "x" | "y"; posMm: number };

export interface SnapResult {
  rect: RectMm;
  hits: GuideHit[];
}

/** Kleinster Abstand (mit Vorzeichen: Linie − Wert) eines Werts zu den Linien, innerhalb `tol`; sonst null. */
function nearest(values: number[], lines: number[], tol: number): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null;
  for (const v of values) {
    for (const l of lines) {
      const d = l - v;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, line: l };
    }
  }
  return best;
}

function linesOf(guides: readonly LayoutGuide[], axis: "x" | "y"): number[] {
  return guides.filter((g) => g.axis === axis && Number.isFinite(g.posMm)).map((g) => g.posMm);
}

/**
 * Fängt ein Rechteck beim Ziehen an Hilfslinien. Körper: linke Kante, Mitte, rechte Kante (bzw. oben, Mitte, unten)
 * gegen die Linien, das ganze Rechteck rutscht. Griff: nur die bewegten Kanten rasten ein, die gegenüberliegende bleibt.
 * `keepAspect` (Bild-Ecke unten rechts): nach dem Einrasten einer Kante folgt die andere über das Seitenverhältnis (Breite/Höhe).
 */
export function snapRectToGuides(
  rect: RectMm,
  handle: Handle,
  guides: readonly LayoutGuide[] | undefined,
  tolMm: number,
  opts: { minMm?: number; keepAspect?: number } = {},
): SnapResult {
  if (!guides || guides.length === 0 || !(tolMm > 0)) return { rect, hits: [] };
  const xs = linesOf(guides, "x");
  const ys = linesOf(guides, "y");
  const minMm = opts.minMm ?? 5;
  const hits: GuideHit[] = [];
  let { xMm, yMm, widthMm, heightMm } = rect;
  const r = rect.xMm + rect.widthMm;
  const b = rect.yMm + rect.heightMm;

  if (handle === "body") {
    const sx = nearest([rect.xMm, rect.xMm + rect.widthMm / 2, r], xs, tolMm);
    if (sx) {
      xMm += sx.delta;
      hits.push({ axis: "x", posMm: sx.line });
    }
    const sy = nearest([rect.yMm, rect.yMm + rect.heightMm / 2, b], ys, tolMm);
    if (sy) {
      yMm += sy.delta;
      hits.push({ axis: "y", posMm: sy.line });
    }
    return { rect: { xMm, yMm, widthMm, heightMm }, hits };
  }

  const movesLeft = handle === "nw" || handle === "w" || handle === "sw";
  const movesRight = handle === "ne" || handle === "e" || handle === "se";
  const movesTop = handle === "nw" || handle === "n" || handle === "ne";
  const movesBottom = handle === "sw" || handle === "s" || handle === "se";

  if (opts.keepAspect && handle === "se") {
    // Beide Kanten bieten eine Breite an; die näher liegende Linie gewinnt.
    const aspect = opts.keepAspect;
    const sx = nearest([r], xs, tolMm);
    const sy = nearest([b], ys, tolMm);
    const useX = sx && (!sy || Math.abs(sx.delta) <= Math.abs(sy.delta * aspect));
    if (useX && sx) {
      widthMm = Math.max(minMm, sx.line - rect.xMm);
      heightMm = widthMm / aspect;
      hits.push({ axis: "x", posMm: sx.line });
    } else if (sy) {
      heightMm = Math.max(minMm / aspect, sy.line - rect.yMm);
      widthMm = heightMm * aspect;
      hits.push({ axis: "y", posMm: sy.line });
    }
    return { rect: { xMm, yMm, widthMm, heightMm }, hits };
  }

  if (movesLeft) {
    const s = nearest([rect.xMm], xs, tolMm);
    if (s && r - s.line >= minMm) {
      xMm = s.line;
      widthMm = r - s.line;
      hits.push({ axis: "x", posMm: s.line });
    }
  } else if (movesRight) {
    const s = nearest([r], xs, tolMm);
    if (s && s.line - rect.xMm >= minMm) {
      widthMm = s.line - rect.xMm;
      hits.push({ axis: "x", posMm: s.line });
    }
  }
  if (movesTop) {
    const s = nearest([rect.yMm], ys, tolMm);
    if (s && b - s.line >= minMm) {
      yMm = s.line;
      heightMm = b - s.line;
      hits.push({ axis: "y", posMm: s.line });
    }
  } else if (movesBottom) {
    const s = nearest([b], ys, tolMm);
    if (s && s.line - rect.yMm >= minMm) {
      heightMm = s.line - rect.yMm;
      hits.push({ axis: "y", posMm: s.line });
    }
  }
  return { rect: { xMm, yMm, widthMm, heightMm }, hits };
}

// ── Hilfslinien ändern ───────────────────────────────────────────────────────

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Linie anfügen (gleiche Achse + Position nur einmal, Position auf 0.01 mm). */
export function addGuide(guides: readonly LayoutGuide[] | undefined, axis: "x" | "y", posMm: number): LayoutGuide[] {
  const list = [...(guides ?? [])];
  const pos = r2(posMm);
  if (!Number.isFinite(pos) || list.some((g) => g.axis === axis && r2(g.posMm) === pos)) return list;
  return [...list, { axis, posMm: pos }];
}

/** Linie `index` entfernen. */
export function removeGuide(guides: readonly LayoutGuide[] | undefined, index: number): LayoutGuide[] {
  return (guides ?? []).filter((_, i) => i !== index);
}

/** Linie `index` auf eine neue Position setzen (Duplikate auf derselben Achse fallen weg). */
export function moveGuide(guides: readonly LayoutGuide[] | undefined, index: number, posMm: number): LayoutGuide[] {
  const list = [...(guides ?? [])];
  const g = list[index];
  if (!g || !Number.isFinite(posMm)) return list;
  const pos = r2(posMm);
  list[index] = { ...g, posMm: pos };
  return list.filter((x, i) => i === index || !(x.axis === g.axis && r2(x.posMm) === pos));
}

/** Nächste Linie innerhalb `tolMm` an einem Blattpunkt (zum Greifen); sonst -1. */
export function guideAt(guides: readonly LayoutGuide[] | undefined, xMm: number, yMm: number, tolMm: number): number {
  let best = -1;
  let bestD = tolMm;
  (guides ?? []).forEach((g, i) => {
    const d = Math.abs((g.axis === "x" ? xMm : yMm) - g.posMm);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

// ── Bild-Zuschnitt durch Ziehen ──────────────────────────────────────────────

/** Kleinster Ausschnitt (Anteil an der Kantenlänge des Originals). */
export const MIN_CROP_FRAC = 0.02;

/**
 * Kante(n) des Ausschnitts `clip` ziehen. `draw` ist das GANZE Original auf dem Blatt (bleibt stehen); der Ausschnitt
 * bleibt darin und mindestens `MIN_CROP_FRAC` gross. `body` verschiebt den Ausschnitt im Original.
 */
export function dragCropClip(draw: RectMm, clip: RectMm, handle: Handle, dxMm: number, dyMm: number): RectMm {
  const minW = draw.widthMm * MIN_CROP_FRAC;
  const minH = draw.heightMm * MIN_CROP_FRAC;
  const dr = draw.xMm + draw.widthMm;
  const db = draw.yMm + draw.heightMm;
  let l = clip.xMm;
  let t = clip.yMm;
  let r = clip.xMm + clip.widthMm;
  let b = clip.yMm + clip.heightMm;
  if (handle === "body") {
    const w = r - l;
    const h = b - t;
    l = Math.min(Math.max(l + dxMm, draw.xMm), dr - w);
    t = Math.min(Math.max(t + dyMm, draw.yMm), db - h);
    return { xMm: l, yMm: t, widthMm: w, heightMm: h };
  }
  if (handle === "nw" || handle === "w" || handle === "sw") l = Math.min(Math.max(l + dxMm, draw.xMm), r - minW);
  if (handle === "ne" || handle === "e" || handle === "se") r = Math.max(Math.min(r + dxMm, dr), l + minW);
  if (handle === "nw" || handle === "n" || handle === "ne") t = Math.min(Math.max(t + dyMm, draw.yMm), b - minH);
  if (handle === "sw" || handle === "s" || handle === "se") b = Math.max(Math.min(b + dyMm, db), t + minH);
  return { xMm: l, yMm: t, widthMm: r - l, heightMm: b - t };
}

/** Zuschnitt-Anteile (0..1) des Ausschnitts `clip` im Original `draw`; `undefined`, wenn er das ganze Original zeigt. */
export function clipToCrop(draw: RectMm, clip: RectMm): { x: number; y: number; w: number; h: number } | undefined {
  const x = (clip.xMm - draw.xMm) / draw.widthMm;
  const y = (clip.yMm - draw.yMm) / draw.heightMm;
  const w = clip.widthMm / draw.widthMm;
  const h = clip.heightMm / draw.heightMm;
  const eps = 1e-4;
  if (x < eps && y < eps && w > 1 - eps && h > 1 - eps) return undefined;
  const q = (v: number): number => Math.round(v * 1e5) / 1e5;
  return { x: Math.max(0, q(x)), y: Math.max(0, q(y)), w: q(w), h: q(h) };
}
