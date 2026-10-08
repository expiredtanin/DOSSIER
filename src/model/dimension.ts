// Gemeinsame Geometrie der Bemassung (SIA 400 B.5.3) — von BEIDEN Seiten
// genutzt: vom Rendering (`plan/generatePlan/drawing2d.ts`) und von den
// Griffen (`state/projectSlice.ts`). Bewusst hier statt doppelt gerechnet:
// sonst driften Masszahl-Position und Masszahl-Griff auseinander, sobald eine
// der beiden Stellen angepasst wird.
//
// EINHEITEN: die Bemassungs-Feinheiten sind PAPIER-MILLIMETER (so denkt die
// Zeichnungsnorm: „Überstand 2 mm", unabhängig vom Massstab). Umgerechnet
// wird mit dem Massstab des jeweiligen Plans (`mmToModel`) — die Funktionen
// hier unten rechnen dann in Modell-Metern, weil die Plan-Geometrie so
// vorliegt. Der Plan wird je Ziel (Bildschirm, Layout-Viewport) EIGENS
// erzeugt (s. `LayoutSheet.tsx`), der Massstab ist zur Erzeugungszeit also
// bekannt und eindeutig.

import type { Vec2 } from "./types";

/**
 * Defaults in PAPIER-MILLIMETERN (übliche Zeichnungswerte; entsprechen bei
 * 1:50 genau den früheren festen Modellwerten 0.05/0.05/0.15/0.2 m).
 */
export const DIM_DEFAULTS_MM = {
  gap: 1,
  overshoot: 1,
  tickLen: 3,
  textHeight: 4,
} as const;

/** Standard-Massstab, wenn ein Aufrufer keinen mitgibt (1:100, üblichster Planmassstab). */
export const DEFAULT_SCALE_DENOMINATOR = 100;

/** Papier-Millimeter → Modell-Meter beim Massstab 1:`scaleDenominator`. */
export function mmToModel(mm: number, scaleDenominator: number): number {
  return (mm / 1000) * scaleDenominator;
}

/** Modell-Meter → Papier-Millimeter (Umkehrung von {@link mmToModel}). */
export function modelToMm(m: number, scaleDenominator: number): number {
  return (m * 1000) / scaleDenominator;
}

/**
 * Lage der Masszahl EINES Segments in ihrer Standardstellung plus die beiden
 * Achsen, in denen ein Nutzer-Versatz (`textOffsets`) gemessen wird:
 * `read` = Leserichtung der Zahl, `up` = quer dazu (von der Masslinie weg).
 * Die Leserichtung ist nie kopfüber (wie beim Rendern), damit „nach oben"
 * für den Nutzer oben bleibt, egal wie die Kette gedreht ist.
 */
export function dimTextFrame(
  a: Vec2,
  b: Vec2,
  offset: number,
  textHeight: number,
): { base: Vec2; read: Vec2; up: Vec2; angle: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mid: Vec2 = {
    x: (a.x + b.x) / 2 + nx * offset,
    y: (a.y + b.y) / 2 + ny * offset,
  };
  let angle = Math.atan2(dy, dx);
  if (Math.cos(angle) < 0) angle += Math.PI;
  const read: Vec2 = { x: Math.cos(angle), y: Math.sin(angle) };
  const up: Vec2 = { x: -Math.sin(angle), y: Math.cos(angle) };
  return {
    base: { x: mid.x + up.x * textHeight * 0.6, y: mid.y + up.y * textHeight * 0.6 },
    read,
    up,
    angle,
  };
}

/** Endgültige Position der Masszahl inkl. Nutzer-Versatz. */
export function dimTextPos(
  a: Vec2,
  b: Vec2,
  offset: number,
  textHeight: number,
  textOffset: { along: number; perp: number } | undefined,
): Vec2 {
  const f = dimTextFrame(a, b, offset, textHeight);
  const o = textOffset ?? { along: 0, perp: 0 };
  return {
    x: f.base.x + f.read.x * o.along + f.up.x * o.perp,
    y: f.base.y + f.read.y * o.along + f.up.y * o.perp,
  };
}

/**
 * Zerlegt eine gezogene Masszahl-Position in den Versatz (along/perp) und
 * lässt ihn dabei EINRASTEN: nahe der Standardlage wird die jeweilige Achse
 * exakt auf 0 gezogen (Nutzer-Wunsch „schiebbar, aber trotzdem einrastend").
 * Beide Achsen rasten unabhängig — man kann die Zahl also seitlich
 * verschieben und trotzdem exakt auf Standardhöhe bleiben.
 */
export function dimTextOffsetFromPoint(
  a: Vec2,
  b: Vec2,
  offset: number,
  textHeight: number,
  pt: Vec2,
): { along: number; perp: number } {
  const f = dimTextFrame(a, b, offset, textHeight);
  const vx = pt.x - f.base.x;
  const vy = pt.y - f.base.y;
  const snap = textHeight * 0.5; // Fangbereich ≈ halbe Schrifthöhe
  const along = vx * f.read.x + vy * f.read.y;
  const perp = vx * f.up.x + vy * f.up.y;
  return {
    along: Math.abs(along) < snap ? 0 : along,
    perp: Math.abs(perp) < snap ? 0 : perp,
  };
}
