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
import { wrapDocToLines } from "./renderHtml";
import { contentFontBaselineFromTop, TEXT_LINE_HEIGHT_MULT } from "./fontMetrics";

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

/** Geschätzter Zeichenbreite-Faktor je Schriftgrösse — deckt sich mit
 *  `CHAR_WIDTH_FACTOR` in `renderHtml.ts` (dort nicht exportiert; kein echtes
 *  Font-Measuring im SVG, reicht aber für Rahmen/Griffe). */
const TEXT_CHAR_WIDTH_FACTOR = 0.55;

/**
 * Vier Eckpunkte (Modell-Meter, Reihenfolge oben-links · oben-rechts ·
 * unten-rechts · unten-links VOR Rotation) eines groben Rahmens um einen
 * gezeichneten Text. Höhe aus der ECHTEN Zeilenzahl (`wrapDocToLines`,
 * dieselbe Umbruch-Logik wie beim Rendern in `primitives.tsx`
 * "drawingText"), Breite aus der längsten Zeile geschätzt (oder `wrapWidth`,
 * falls gesetzt — dann ist die Spaltenbreite exakt bekannt). `at` ist die
 * Baseline-links der ERSTEN Zeile; Rotation um `angle` (CCW, Modell-Radiant)
 * um genau diesen Punkt, analog zum SVG-`rotate` beim eigentlichen Rendern.
 */
export function textFrameCorners(p: TextFrameInput): Vec2[] {
  const doc = p.doc ?? docFromText(p.text, p.marks ?? {});
  const lineHeight = p.heightM * TEXT_LINE_HEIGHT_MULT;
  const wrapWidthUnits = p.wrapWidth && p.wrapWidth > 0 ? p.wrapWidth : undefined;
  const lines = wrapDocToLines(doc, {
    x: 0,
    y: 0,
    lineHeight,
    unitPerPt: 1,
    basePt: p.heightM,
    ...(wrapWidthUnits ? { wrapWidthUnits } : {}),
  });
  const maxLineChars = lines.length
    ? Math.max(1, ...lines.map((l) => l.tspans.reduce((n, t) => n + t.text.length, 0)))
    : 1;
  const width =
    wrapWidthUnits ?? Math.max(p.heightM, maxLineChars * p.heightM * TEXT_CHAR_WIDTH_FACTOR);
  const height = Math.max(1, lines.length) * lineHeight;
  // Baseline → Oberkante erste Zeile: echtes Font-Measuring statt der groben
  // "ganzes heightM"-Näherung.
  const top = p.heightM * contentFontBaselineFromTop(TEXT_LINE_HEIGHT_MULT);
  const local: Vec2[] = [
    { x: 0, y: top },
    { x: width, y: top },
    { x: width, y: top - height },
    { x: 0, y: top - height },
  ];
  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  return local.map((l) => ({
    x: p.at.x + l.x * cos - l.y * sin,
    y: p.at.y + l.x * sin + l.y * cos,
  }));
}
