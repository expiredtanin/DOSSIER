// Gemeinsame Geometrie der Bemassung (SIA 400 B.5.3) — von BEIDEN Seiten
// genutzt: vom Rendering (Rust-Kern, `plan/drawings.rs`) und von den Griffen
// (`state/projectSlice.ts`). Die Lage der Masszahl (`dimTextFrame`) rechnet nur
// der Kern (Bindung `dim_text_frame`): sonst driften Masszahl-Position und
// Masszahl-Griff auseinander, sobald eine der beiden Stellen angepasst wird.
//
// EINHEITEN: die Bemassungs-Feinheiten sind PAPIER-MILLIMETER (so denkt die
// Zeichnungsnorm: „Überstand 2 mm", unabhängig vom Massstab). Umgerechnet
// wird mit dem Massstab des jeweiligen Plans (`mmToModel`) — die Funktionen
// hier unten rechnen dann in Modell-Metern, weil die Plan-Geometrie so
// vorliegt. Der Plan wird je Ziel (Bildschirm, Layout-Viewport) EIGENS
// erzeugt (s. `LayoutSheet.tsx`), der Massstab ist zur Erzeugungszeit also
// bekannt und eindeutig.

import type { Vec2 } from "./types";
import { core } from "../engine/coreWasm";

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

/** Default-Grösse der Linienenden (Pfeil, Punkt, …) in Papier-Millimetern (wie im Kern). */
export const END_MARK_DEFAULT_SIZE_MM = 3;

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
  const f = core().dim_text_frame(a.x, a.y, b.x, b.y, offset, textHeight);
  if (f.length < 7) return { base: { x: NaN, y: NaN }, read: { x: NaN, y: NaN }, up: { x: NaN, y: NaN }, angle: NaN };
  return { base: { x: f[0], y: f[1] }, read: { x: f[2], y: f[3] }, up: { x: f[4], y: f[5] }, angle: f[6] };
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
