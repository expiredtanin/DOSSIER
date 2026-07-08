// Reine, testbare Geometrie für die In-Viewport-Layout-Ansicht (Phase 2b):
// Bildschirm↔Blatt-mm-Transform (Pan/Zoom-to-Cursor/Einpassen), Viewport-
// Trefferlogik (Body + 8 Resize-Griffe), Resize-Mathe mit Mindestgrösse,
// Rechteck-Normalisierung (Aufziehen) und Clamp an die Blattkanten.
//
// KEINE React-/DOM-Abhängigkeit — nur Zahlen. Das UI (LayoutSheet.tsx) baut
// darauf auf. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { LayoutAnnotation, LayoutViewport } from "../model/types";

/**
 * Affine Blatt-Transform: Bildschirm-Pixel = mm · scale + translate.
 * `scale` ist px pro mm (immer > 0), `tx/ty` die Blatt-Ursprungslage (mm 0,0)
 * in Canvas-Pixeln.
 */
export interface SheetTransform {
  /** Pixel pro Millimeter (> 0). */
  scale: number;
  /** Bildschirm-X des Blatt-Ursprungs (mm x=0) in Canvas-Pixeln. */
  tx: number;
  /** Bildschirm-Y des Blatt-Ursprungs (mm y=0) in Canvas-Pixeln. */
  ty: number;
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

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 40;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── Transform ────────────────────────────────────────────────────────────────

/** Blatt-mm → Canvas-Pixel. */
export function mmToScreen(t: SheetTransform, p: Mm): { x: number; y: number } {
  return { x: p.xMm * t.scale + t.tx, y: p.yMm * t.scale + t.ty };
}

/** Canvas-Pixel → Blatt-mm. */
export function screenToMm(t: SheetTransform, sx: number, sy: number): Mm {
  return { xMm: (sx - t.tx) / t.scale, yMm: (sy - t.ty) / t.scale };
}

/**
 * Einpass-Transform: Blatt (mm) zentriert in die Canvas-Fläche (px), mit
 * `margin` (Anteil, z. B. 0.92 = 8 % Rand). Degenerierte Eingaben → scale=1.
 */
export function fitTransform(
  sheetWMm: number,
  sheetHMm: number,
  canvasWPx: number,
  canvasHPx: number,
  margin = 0.92,
): SheetTransform {
  const sx = (canvasWPx * margin) / sheetWMm;
  const sy = (canvasHPx * margin) / sheetHMm;
  let scale = Math.min(sx, sy);
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  scale = clamp(scale, MIN_SCALE, MAX_SCALE);
  const tx = (canvasWPx - sheetWMm * scale) / 2;
  const ty = (canvasHPx - sheetHMm * scale) / 2;
  return { scale, tx, ty };
}

/**
 * Zoom um den Cursor: der mm-Punkt unter (sx,sy) bleibt fix. `factor` > 1 zoomt
 * rein, < 1 raus; der Massstab wird auf [MIN_SCALE, MAX_SCALE] geklemmt.
 */
export function zoomAtCursor(
  t: SheetTransform,
  factor: number,
  sx: number,
  sy: number,
): SheetTransform {
  const newScale = clamp(t.scale * factor, MIN_SCALE, MAX_SCALE);
  // mm-Punkt unter dem Cursor VOR dem Zoom.
  const m = screenToMm(t, sx, sy);
  // Neue Translation, damit derselbe mm-Punkt wieder unter (sx,sy) liegt.
  return { scale: newScale, tx: sx - m.xMm * newScale, ty: sy - m.yMm * newScale };
}

/** Verschiebt die Transform um (dxPx,dyPx) Canvas-Pixel (Pan). */
export function panBy(t: SheetTransform, dxPx: number, dyPx: number): SheetTransform {
  return { scale: t.scale, tx: t.tx + dxPx, ty: t.ty + dyPx };
}

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

// ── Annotationen (Linie/Rechteck/Text) ──────────────────────────────────────
// Annotationen tragen KEINE Resize-Griffe (nur verschieben + löschen) — daher
// reicht ein einfacher Treffer-Test (kein Handle-Ergebnis wie bei Viewports).

/** Kürzester Abstand (mm) eines Punkts zu einem Liniensegment. */
export function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / lenSq, 0, 1);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Umhüllendes Rechteck (mm) einer Annotation — für Text nur eine GROBE Box
 * (kein echtes Font-Measuring im SVG; Breite aus Zeichenzahl geschätzt), reicht
 * aber für Trefferlogik + Auswahl-Rahmen. `yMm` einer Text-Annotation ist die
 * Baseline, die Box liegt daher oberhalb davon.
 */
export function annotationBoundsMm(ann: LayoutAnnotation): RectMm {
  if (ann.kind === "rect") {
    return { xMm: ann.xMm, yMm: ann.yMm, widthMm: ann.widthMm, heightMm: ann.heightMm };
  }
  if (ann.kind === "line") {
    return normalizeRect(ann.x1Mm, ann.y1Mm, ann.x2Mm, ann.y2Mm);
  }
  const widthMm = Math.max(ann.heightMm, ann.text.length * ann.heightMm * 0.6);
  return {
    xMm: ann.xMm,
    yMm: ann.yMm - ann.heightMm,
    widthMm,
    heightMm: ann.heightMm * 1.25,
  };
}

/**
 * Trefferlogik (mm) für EINE Annotation: Linie → Abstand zum Segment ≤ tolMm;
 * Rechteck → Rahmen ODER Innenfläche (wiederverwendet {@link handleAt}, jeder
 * Nicht-null-Rückgabewert zählt als Treffer); Text → Bounding-Box + Toleranz.
 */
export function annotationHit(
  ann: LayoutAnnotation,
  xMm: number,
  yMm: number,
  tolMm: number,
): boolean {
  if (ann.kind === "line") {
    return distanceToSegment(xMm, yMm, ann.x1Mm, ann.y1Mm, ann.x2Mm, ann.y2Mm) <= tolMm;
  }
  if (ann.kind === "rect") {
    const r: RectMm = { xMm: ann.xMm, yMm: ann.yMm, widthMm: ann.widthMm, heightMm: ann.heightMm };
    return handleAt(r, xMm, yMm, tolMm) !== null;
  }
  const b = annotationBoundsMm(ann);
  return (
    xMm >= b.xMm - tolMm &&
    xMm <= b.xMm + b.widthMm + tolMm &&
    yMm >= b.yMm - tolMm &&
    yMm <= b.yMm + b.heightMm + tolMm
  );
}

/**
 * Topmost-Treffer über eine Annotations-Liste (letzte = oberste, wie
 * {@link pickViewport}). Liefert die Id des ERSTEN Treffers von oben, sonst null.
 */
export function pickAnnotation(
  annotations: LayoutAnnotation[],
  xMm: number,
  yMm: number,
  tolMm: number,
): string | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (annotationHit(a, xMm, yMm, tolMm)) return a.id;
  }
  return null;
}

/** Verschiebt eine Annotation um ein mm-Delta — alle ihre Punkte wandern mit. */
export function translateAnnotation(
  ann: LayoutAnnotation,
  dxMm: number,
  dyMm: number,
): LayoutAnnotation {
  if (ann.kind === "line") {
    return {
      ...ann,
      x1Mm: ann.x1Mm + dxMm,
      y1Mm: ann.y1Mm + dyMm,
      x2Mm: ann.x2Mm + dxMm,
      y2Mm: ann.y2Mm + dyMm,
    };
  }
  return { ...ann, xMm: ann.xMm + dxMm, yMm: ann.yMm + dyMm };
}
