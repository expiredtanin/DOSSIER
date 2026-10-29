// Geschätzter Rahmen (Modell-Meter) eines gezeichneten Textes — EINE Quelle
// für sowohl die visuelle Anzeige (PlanView.tsx Auswahl-Rahmen/Inline-Editor-
// Anker) als auch die Eckpunkt-Griffe der Textspalte (`geometry/grips.ts`
// drawingVertices). Reines Modul: kein React, kein DOM zwingend nötig
// (`contentFontBaselineFromTop` fällt ohne Canvas sicher auf einen
// Näherungswert zurück, s. dort) — darf daher auch aus dem Store-Slice
// heraus aufgerufen werden.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Vec2 } from "../model/types";
import type { Marks, RichTextDoc } from "./richText";
import { docFromText } from "./richText";
import { contentFontBaselineFromTop, TEXT_LINE_HEIGHT_MULT } from "./fontMetrics";
import { core } from "../engine/coreWasm";

/** Minimale Felder, die `textFrameCorners` braucht — sowohl `Primitive`
 *  ("drawingText", PlanView.tsx) als auch `Drawing2DGeom["text"]`
 *  (projectSlice.ts) erfüllen das strukturell (Primitive ist ein Superset). */
export interface TextFrameInput {
  at: Vec2;
  text: string;
  /** Schrifthöhe in Modell-Metern. */
  heightM: number;
  /** Drehung in Radiant (CCW im Modell). */
  angle: number;
  marks?: Marks;
  doc?: RichTextDoc;
  /** Spaltenbreite in Modell-Metern (Textspalte); fehlt ⇒ Breite geschätzt. */
  wrapWidth?: number;
}

/**
 * Vier Eckpunkte (Modell-Meter, Reihenfolge oben-links · oben-rechts ·
 * unten-rechts · unten-links VOR Rotation) eines groben Rahmens um einen
 * gezeichneten Text. Rechnet der Kern (`text_layout::text_frame_corners`): Höhe aus der
 * ECHTEN Zeilenzahl (derselbe Umbruch wie beim Rendern), Breite aus der längsten Zeile
 * geschätzt (UTF-16-Länge × Höhe × 0.55, oder `wrapWidth`, falls gesetzt). `at` ist die
 * Baseline-links der ERSTEN Zeile; Rotation um `angle` (CCW, Modell-Radiant) um genau
 * diesen Punkt. Hier bleibt nur die Canvas-Messung Baseline → Oberkante.
 */
export function textFrameCorners(p: TextFrameInput): Vec2[] {
  const doc = p.doc ?? docFromText(p.text, p.marks ?? {});
  const top = contentFontBaselineFromTop(TEXT_LINE_HEIGHT_MULT);
  const f = core().text_frame(JSON.stringify(doc), Float64Array.of(p.at.x, p.at.y, p.heightM, p.angle, p.wrapWidth ?? NaN, top));
  if (f.length !== 8) return [p.at, p.at, p.at, p.at].map((q) => ({ x: q.x, y: q.y }));
  return [0, 2, 4, 6].map((i) => ({ x: f[i], y: f[i + 1] }));
}
