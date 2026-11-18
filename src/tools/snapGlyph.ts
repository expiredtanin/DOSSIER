// [288] Fangpunkt-Darstellung (Vectorworks-Smart-Cursor als Leitbild): je Fangart ein eigenes Symbol und ein kurzer
// Hinweis neben dem Zeiger („Endpunkt", „Mitte" …; bei Hilfslinien mit Abstand bzw. Winkel). Reine Zuordnung, die
// Zeichnung macht `views/plan/planView/overlays.tsx` (2D); Beschriftung über `t()` (de/en).

import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { MODEL_UNITS, fmtLength, type DisplayUnits } from "./displayUnits";
import type { SnapKind, SnapResult } from "./types";

/** Symbol je Fangart. */
export type SnapGlyph =
  | "square" // Endpunkt
  | "triangle" // Mitte
  | "cross" // Schnittpunkt (X)
  | "perp" // Lot / senkrecht (rechter Winkel)
  | "circle" // Zentrum / Quadrant
  | "diamond" // auf Kante (hohle Raute)
  | "diamondFill" // Teilpunkt (gefüllte Raute)
  | "tangent" // Tangente (Kreis + Berührlinie)
  | "parallel" // parallel (∥)
  | "plus" // Ortho / Verlängerung (Punkt auf einer Hilfslinie)
  | "dot" // Raster
  | "none"; // Winkel-Fang (eigene Führungslinie + Winkel-Badge)

const GLYPH: Record<SnapKind, SnapGlyph> = {
  endpoint: "square",
  midpoint: "triangle",
  intersection: "cross",
  center: "circle",
  quadrant: "circle",
  onEdge: "diamond",
  grid: "dot",
  ortho: "plus",
  extension: "plus",
  angle: "none",
  divide: "diamondFill",
  perpendicular: "perp",
  tangent: "tangent",
  parallel: "parallel",
};

export function snapGlyph(kind: SnapKind): SnapGlyph {
  return GLYPH[kind] ?? "square";
}

/** Übersetzungsschlüssel des Kurzhinweises; null = keiner (Winkel-Fang hat sein eigenes Badge). */
export function snapTipKey(kind: SnapKind): TranslationKey | null {
  return kind === "angle" ? null : (`snap.tip.${kind}` as TranslationKey);
}

/**
 * Kurzhinweis am Zeiger. Bei Hilfslinien (Ortho, Verlängerung) mit Abstand zum Bezugspunkt, Ortho zusätzlich mit
 * Richtung in Grad (0/90/180/270).
 */
export function snapTipText(snap: SnapResult, units: DisplayUnits = MODEL_UNITS): string | null {
  const key = snapTipKey(snap.kind);
  if (!key) return null;
  const label = t(key);
  if ((snap.kind === "ortho" || snap.kind === "extension") && snap.refA) {
    const dx = snap.point.x - snap.refA.x;
    const dy = snap.point.y - snap.refA.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) return label;
    if (snap.kind === "ortho") {
      const deg = ((Math.round((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
      return `${label} ${deg}° · ${fmtLength(units, d)}`;
    }
    return `${label} · ${fmtLength(units, d)}`;
  }
  return label;
}
