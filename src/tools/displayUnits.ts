// Anzeige-Einheiten der 2D-Ansicht ([93]): im Modell Meter (y nach oben), auf einem offenen Layout-Blatt
// Papier-mm mit y nach unten wie auf dem Papier (die Blatt-Ebene rechnet in Papier-Metern mit
// Ursprung oben links und Papier-y = −y, s. `sheetMmToModel`). Lineale, Statusleiste, Objekt-Info,
// Cursor-HUD und Befehlszeile zeigen Werte über diese Umrechnung und lesen getippte Werte zurück.

import type { Vec2 } from "../model/types";

export interface DisplayUnits {
  /** Anzeige-Einheiten je Meter (1 bzw. 1000). */
  perMeter: number;
  /** Einheit hinter der Zahl. */
  suffix: "m" | "mm";
  /** Nachkommastellen fester Anzeigen. */
  digits: number;
  /** Papier-y nach unten (Anzeige-y = −Modell-y). */
  flipY: boolean;
}

export const MODEL_UNITS: DisplayUnits = { perMeter: 1, suffix: "m", digits: 3, flipY: false };
export const PAPER_UNITS: DisplayUnits = { perMeter: 1000, suffix: "mm", digits: 1, flipY: true };

/** Einheiten der Ebene: Papier-mm auf einer Blatt-Ebene (`layoutId`), sonst Meter. */
export function unitsForLevel(level: { layoutId?: string | null } | null | undefined): DisplayUnits {
  return level?.layoutId ? PAPER_UNITS : MODEL_UNITS;
}

/** Länge (Meter) → Anzeige-Zahl. */
export const lengthToDisplay = (u: DisplayUnits, m: number): number => m * u.perMeter;
/** Anzeige-Zahl → Länge (Meter). */
export const lengthFromDisplay = (u: DisplayUnits, v: number): number => v / u.perMeter;
/** Modell-x → Anzeige-x. */
export const xToDisplay = (u: DisplayUnits, x: number): number => x * u.perMeter;
/** Modell-y → Anzeige-y (auf dem Papier nach unten). */
export const yToDisplay = (u: DisplayUnits, y: number): number => (u.flipY ? -y : y) * u.perMeter;
/** Anzeige-y → Modell-y. */
export const yFromDisplay = (u: DisplayUnits, v: number): number => (u.flipY ? -v : v) / u.perMeter;
/** Modell-Δy → Anzeige-Δy. */
export const dyToDisplay = yToDisplay;

/** Zahl ohne „−0" und mit den festen Nachkommastellen der Einheit. */
export function fmtDisplay(u: DisplayUnits, v: number, digits = u.digits): string {
  const r = Number(v.toFixed(digits));
  return (Object.is(r, -0) || Math.abs(r) < 10 ** -(digits + 1) ? 0 : r).toFixed(digits);
}

/** Länge (Meter) als Text mit Einheit, z. B. „3.000m" bzw. „12.5mm". */
export const fmtLength = (u: DisplayUnits, m: number): string => `${fmtDisplay(u, lengthToDisplay(u, m))}${u.suffix}`;

/** Lineal-Beschriftung einer x- bzw. y-Marke (Modell-Meter). */
export function rulerLabel(u: DisplayUnits, axis: "x" | "y", v: number): string {
  const d = axis === "x" ? xToDisplay(u, v) : yToDisplay(u, v);
  if (u === MODEL_UNITS || u.perMeter === 1) return `${fmtDisplay(u, d, 3)}m`;
  // Papier: ganze mm, wo es aufgeht (Schritte ≥ 1 mm), sonst eine Stelle.
  const whole = Math.abs(d - Math.round(d)) < 1e-6;
  return `${fmtDisplay(u, d, whole ? 0 : 1)}`;
}

/**
 * Getippte Koordinaten-/Längeneingabe (`parseInput`) in Modellwerte: Punkte und Längen aus Anzeige-
 * Einheiten in Meter, Papier-y zurück nach Modell-y. Winkel bleiben (gegen den Uhrzeigersinn auf dem
 * Bildschirm, wie im Modell).
 */
export function pointFromDisplay(u: DisplayUnits, p: Vec2): Vec2 {
  return { x: lengthFromDisplay(u, p.x), y: yFromDisplay(u, p.y) };
}
