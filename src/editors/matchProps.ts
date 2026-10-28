// „Eigenschaften übertragen" für 2D-Elemente (Match Properties) — reine
// Modell-Funktionen, damit sie ohne UI testbar bleiben.
//
// Übertragen wird ausschliesslich das AUSSEHEN, nie Identität, Lage oder Form:
// Farbe/Stift, Strichstärke, Linienstil und dessen Massstab, Füllung
// (Schraffur samt Platzierung, Vorder-/Hintergrund, Vollton), Transparenz,
// Linienenden — plus die By-Layer/By-Object-Quellen, weil ein kopiertes
// Aussehen sonst je nach Quelle anders aufgelöst würde.
//
// NICHT übertragen: `id`, `type`, `geom` (Form), `levelId` (Zeichnungsebene)
// und `categoryCode` (Ebene) — die Ebene ist Organisation, nicht Aussehen; wer
// sie mitnehmen wollte, verschöbe das Element ungewollt in eine andere Ebene.

import type { Drawing2D, Project } from "../model/types";
import { patchItems } from "../core";
import type { CoreOp } from "../core";

/** Die übertragbaren Stil-Felder eines 2D-Elements. */
export type DrawingStyle = Pick<
  Drawing2D,
  | "lineStyleId"
  | "hatchId"
  | "foreground"
  | "background"
  | "foregroundPenId"
  | "backgroundPenId"
  | "color"
  | "colorPenId"
  | "dashScale"
  | "hatchAngleDeg"
  | "hatchScale"
  | "opacity"
  | "endMarks"
  | "fillColor"
  | "weightMm"
  | "foregroundSource"
  | "backgroundSource"
  | "strokeWeightSource"
  | "hatchSource"
>;

/**
 * Feldnamen des Stils. Bewusst als Liste statt „alles ausser X": kommt ein
 * neues Stil-Feld dazu, fällt beim Ergänzen hier auf, dass es auch übertragen
 * werden sollte — bei einer Negativliste würde es still mitkopiert, auch wenn
 * es gar kein Stil ist.
 */
const STYLE_KEYS = [
  "lineStyleId",
  "hatchId",
  "foreground",
  "background",
  "foregroundPenId",
  "backgroundPenId",
  "color",
  "colorPenId",
  "dashScale",
  "hatchAngleDeg",
  "hatchScale",
  "opacity",
  "endMarks",
  "fillColor",
  "weightMm",
  "foregroundSource",
  "backgroundSource",
  "strokeWeightSource",
  "hatchSource",
] as const satisfies readonly (keyof DrawingStyle)[];

/** Liest den Stil eines Elements heraus (nur gesetzte Felder). */
export function readDrawingStyle(d: Drawing2D): DrawingStyle {
  const style: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) {
    if (d[k] !== undefined) style[k] = d[k];
  }
  return style as DrawingStyle;
}

/**
 * Überträgt einen Stil auf die genannten Elemente. Felder, die die Quelle NICHT
 * gesetzt hatte, werden am Ziel ENTFERNT — sonst bliebe z. B. eine alte
 * Schraffur stehen, obwohl die Quelle keine hat, und das Ergebnis sähe anders
 * aus als das Vorbild.
 *
 * Der Schraffur-URSPRUNG wird bewusst nicht mitgenommen: er ist ein
 * Ortsbezug (ein Ankerpunkt im Modell), kein Aussehen — am Ziel läge das
 * Muster sonst an einer sinnlosen Stelle.
 */
export function applyDrawingStyleOps(project: Project, ids: string[], style: DrawingStyle): CoreOp[] {
  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  return patchItems(project, "drawings2d", wanted, (d) => {
    const next: Record<string, unknown> = { ...d };
    for (const k of STYLE_KEYS) {
      if (style[k] === undefined) delete next[k];
      else next[k] = style[k];
    }
    return next as unknown as Drawing2D;
  });
}
