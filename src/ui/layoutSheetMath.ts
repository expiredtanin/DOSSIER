// Reine, testbare Geometrie für die Viewports auf dem Layout-Blatt: Viewport-
// Trefferlogik (Body + 8 Resize-Griffe), Resize-Mathe mit Mindestgrösse,
// Rechteck-Normalisierung (Aufziehen) und Clamp an die Blattkanten.
//
// KEINE React-/DOM-Abhängigkeit — nur Zahlen. Das UI (LayoutSheet.tsx) baut
// darauf auf. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { LayoutViewport } from "../model/types";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Ein Punkt in Blatt-Millimetern. */
export interface Mm {
  xMm: number;
  yMm: number;
}

/** Ein achsparalleles Rechteck in Blatt-Millimetern. */
export interface RectMm {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

/** Resize-Griff (8 Ränder) oder Körper (verschieben) eines Viewports. */
export type Handle =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "body";

// ── Viewport-Rechtecke / Treffer ─────────────────────────────────────────────

/** Rechteck-Sicht eines Viewports (nur die Blattgeometrie). */
export function vpRect(vp: LayoutViewport): RectMm {
  return { xMm: vp.xMm, yMm: vp.yMm, widthMm: vp.widthMm, heightMm: vp.heightMm };
}

/** Punkt-in-Rechteck (mm), inklusive Rand. */
export function rectContains(r: RectMm, xMm: number, yMm: number): boolean {
  return (
    xMm >= r.xMm &&
    xMm <= r.xMm + r.widthMm &&
    yMm >= r.yMm &&
    yMm <= r.yMm + r.heightMm
  );
}

/**
 * Griff (oder Körper) an einem mm-Punkt für EINEN Viewport. `tolMm` ist die
 * Fangzone der Ecken/Kanten (in mm). Rückgabe null, wenn ausserhalb des
 * Rechtecks (+Toleranz). Ecken haben Vorrang vor Kanten, Kanten vor Körper.
 */
export function handleAt(
  r: RectMm,
  xMm: number,
  yMm: number,
  tolMm: number,
): Handle | null {
  const x0 = r.xMm;
  const y0 = r.yMm;
  const x1 = r.xMm + r.widthMm;
  const y1 = r.yMm + r.heightMm;
  // Ausserhalb des um tol vergrösserten Rechtecks → kein Treffer.
  if (xMm < x0 - tolMm || xMm > x1 + tolMm || yMm < y0 - tolMm || yMm > y1 + tolMm) {
    return null;
  }
  const nearL = Math.abs(xMm - x0) <= tolMm;
  const nearR = Math.abs(xMm - x1) <= tolMm;
  const nearT = Math.abs(yMm - y0) <= tolMm;
  const nearB = Math.abs(yMm - y1) <= tolMm;
  // Innerhalb der vertikalen/horizontalen Spanne (für Kanten-Treffer).
  const inX = xMm >= x0 - tolMm && xMm <= x1 + tolMm;
  const inY = yMm >= y0 - tolMm && yMm <= y1 + tolMm;
  // Ecken zuerst.
  if (nearL && nearT) return "nw";
  if (nearR && nearT) return "ne";
  if (nearR && nearB) return "se";
  if (nearL && nearB) return "sw";
  // Kanten.
  if (nearT && inX) return "n";
  if (nearB && inX) return "s";
  if (nearL && inY) return "w";
  if (nearR && inY) return "e";
  // Körper (echt innen).
  if (rectContains(r, xMm, yMm)) return "body";
  return null;
}

/**
 * Topmost-Treffer über eine Viewport-Liste (letzte = oberste, wie Z-Order der
 * Darstellung). Liefert Id + Griff des ERSTEN Treffers von oben, sonst null.
 */
export function pickViewport(
  viewports: LayoutViewport[],
  xMm: number,
  yMm: number,
  tolMm: number,
): { id: string; handle: Handle } | null {
  for (let i = viewports.length - 1; i >= 0; i--) {
    const vp = viewports[i];
    const h = handleAt(vpRect(vp), xMm, yMm, tolMm);
    if (h) return { id: vp.id, handle: h };
  }
  return null;
}

// ── Resize / Move ────────────────────────────────────────────────────────────

/**
 * Wendet einen Griff-Drag auf ein Start-Rechteck an: `handle` bestimmt, welche
 * Kanten mit (dxMm,dyMm) wandern. Körper verschiebt das ganze Rechteck. Die
 * Mindestbreite/-höhe `minMm` wird eingehalten (die feste Kante bleibt fix).
 */
export function applyHandleDrag(
  start: RectMm,
  handle: Handle,
  dxMm: number,
  dyMm: number,
  minMm = 5,
): RectMm {
  if (handle === "body") {
    return { ...start, xMm: start.xMm + dxMm, yMm: start.yMm + dyMm };
  }
  let { xMm, yMm, widthMm, heightMm } = start;
  const movesLeft = handle === "nw" || handle === "w" || handle === "sw";
  const movesRight = handle === "ne" || handle === "e" || handle === "se";
  const movesTop = handle === "nw" || handle === "n" || handle === "ne";
  const movesBottom = handle === "sw" || handle === "s" || handle === "se";

  if (movesLeft) {
    // Rechte Kante fix bei start.xMm + start.widthMm.
    const right = start.xMm + start.widthMm;
    let nx = start.xMm + dxMm;
    if (right - nx < minMm) nx = right - minMm;
    xMm = nx;
    widthMm = right - nx;
  } else if (movesRight) {
    let nw = start.widthMm + dxMm;
    if (nw < minMm) nw = minMm;
    widthMm = nw;
  }

  if (movesTop) {
    const bottom = start.yMm + start.heightMm;
    let ny = start.yMm + dyMm;
    if (bottom - ny < minMm) ny = bottom - minMm;
    yMm = ny;
    heightMm = bottom - ny;
  } else if (movesBottom) {
    let nh = start.heightMm + dyMm;
    if (nh < minMm) nh = minMm;
    heightMm = nh;
  }

  return { xMm, yMm, widthMm, heightMm };
}

/**
 * Normalisiert ein aufgezogenes Rechteck aus zwei Eckpunkten (mm) — Min-Ecke +
 * absolute Breite/Höhe. Für die „Rechteck aufziehen"-Platzierung.
 */
export function normalizeRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): RectMm {
  return {
    xMm: Math.min(x0, x1),
    yMm: Math.min(y0, y1),
    widthMm: Math.abs(x1 - x0),
    heightMm: Math.abs(y1 - y0),
  };
}

/**
 * Klemmt ein Rechteck so, dass es ganz auf dem Blatt (0..sheet) liegt. Ist das
 * Rechteck breiter/höher als das Blatt, wird es auf Blattgrösse gestutzt und an
 * (0,0) gelegt. Sonst bleibt die Grösse erhalten und nur die Position wandert.
 */
export function clampRectToSheet(
  r: RectMm,
  sheetWMm: number,
  sheetHMm: number,
): RectMm {
  let { xMm, yMm, widthMm, heightMm } = r;
  if (widthMm > sheetWMm) {
    widthMm = sheetWMm;
    xMm = 0;
  } else {
    xMm = clamp(xMm, 0, sheetWMm - widthMm);
  }
  if (heightMm > sheetHMm) {
    heightMm = sheetHMm;
    yMm = 0;
  } else {
    yMm = clamp(yMm, 0, sheetHMm - heightMm);
  }
  return { xMm, yMm, widthMm, heightMm };
}

/** CSS-Cursor je Resize-Griff (Körper = move). */
export function handleCursor(handle: Handle): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    default:
      return "move";
  }
}

/**
 * Die 8 Griff-Anker eines Rechtecks in mm (für die Darstellung der Griffe).
 * Reihenfolge passend zu {@link Handle} (ohne „body").
 */
export function handleAnchors(r: RectMm): { handle: Handle; xMm: number; yMm: number }[] {
  const { xMm: x, yMm: y, widthMm: w, heightMm: h } = r;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return [
    { handle: "nw", xMm: x, yMm: y },
    { handle: "n", xMm: cx, yMm: y },
    { handle: "ne", xMm: x + w, yMm: y },
    { handle: "e", xMm: x + w, yMm: cy },
    { handle: "se", xMm: x + w, yMm: y + h },
    { handle: "s", xMm: cx, yMm: y + h },
    { handle: "sw", xMm: x, yMm: y + h },
    { handle: "w", xMm: x, yMm: cy },
  ];
}
