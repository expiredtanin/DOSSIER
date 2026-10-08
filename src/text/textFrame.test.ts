// `textFrameCorners` liefert den geschätzten Rahmen (Modell-Meter) eines
// gezeichneten Textes — Grundlage für den Auswahl-Rahmen im Grundriss
// (PlanView.tsx) UND die Eckpunkt-Griffe einer Textspalte (projectSlice.ts
// `drawingVertices`/`moveGrip`). Reiner Helfer, kein React/DOM nötig.

import { describe, it, expect } from "vitest";
import { textFrameCorners, type TextFrameInput } from "./textFrame";
import { contentFontBaselineFromTop, TEXT_LINE_HEIGHT_MULT } from "./fontMetrics";

// Kein DOM im Testlauf (vitest.config.ts: environment "node") → `document` ist
// nicht definiert, `contentFontBaselineFromTop` fängt das ab und liefert den
// dokumentierten Fallback-Wert — hier explizit ausgelesen statt hart codiert,
// damit der Test bei einer Anpassung des Fallbacks nicht bricht.
const BASELINE_FROM_TOP = contentFontBaselineFromTop(TEXT_LINE_HEIGHT_MULT);

function textInput(overrides: Partial<TextFrameInput>): TextFrameInput {
  return {
    at: { x: 0, y: 0 },
    text: "Hallo",
    heightM: 0.2,
    angle: 0,
    ...overrides,
  };
}

describe("textFrameCorners", () => {
  it("einzeilig, keine Rotation: Rahmen sitzt oberhalb der Baseline (Ascent-Näherung × heightM)", () => {
    const p = textInput({ text: "Hallo" });
    const corners = textFrameCorners(p);
    expect(corners).toHaveLength(4);
    const ys = corners.map((c) => c.y);
    const top = 0.2 * BASELINE_FROM_TOP;
    expect(Math.max(...ys)).toBeCloseTo(top, 9);
    expect(Math.min(...ys)).toBeCloseTo(top - 0.2 * TEXT_LINE_HEIGHT_MULT, 9); // unten = oben - EINE Zeilenhöhe
  });

  it("Breite wächst mit der Zeichenzahl (längerer Text → breiterer Rahmen)", () => {
    const short = textFrameCorners(textInput({ text: "Hi" }));
    const long = textFrameCorners(textInput({ text: "Ein deutlich längerer Text" }));
    const widthOf = (c: { x: number; y: number }[]) =>
      Math.max(...c.map((p) => p.x)) - Math.min(...c.map((p) => p.x));
    expect(widthOf(long)).toBeGreaterThan(widthOf(short));
  });

  it("gesetzte wrapWidth bestimmt die Breite EXAKT (unabhängig von der Zeichenzahl)", () => {
    const p = textInput({ text: "Ein langer Textspalten-Inhalt, der umbricht", wrapWidth: 1.5 });
    const corners = textFrameCorners(p);
    const xs = corners.map((c) => c.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1.5, 9);
  });

  it("mehrzeiliger Text (wrapWidth erzwingt Umbruch) ergibt eine grössere Höhe als einzeilig", () => {
    const oneLine = textFrameCorners(textInput({ text: "kurz", wrapWidth: 5 }));
    const wrapped = textFrameCorners(
      textInput({ text: "eins zwei drei vier fünf sechs sieben acht neun zehn", wrapWidth: 0.6 }),
    );
    const heightOf = (c: { x: number; y: number }[]) =>
      Math.max(...c.map((p) => p.y)) - Math.min(...c.map((p) => p.y));
    expect(heightOf(wrapped)).toBeGreaterThan(heightOf(oneLine));
  });

  it("Rotation (angle=90°) dreht den Rahmen exakt um `at`, ohne die Fläche zu ändern", () => {
    const p0 = textInput({ text: "Hallo", angle: 0 });
    const p90 = textInput({ text: "Hallo", angle: Math.PI / 2 });
    const c0 = textFrameCorners(p0);
    const c90 = textFrameCorners(p90);
    // Fläche bleibt gleich (Shoelace-Formel), nur die Orientierung dreht sich.
    const area = (pts: { x: number; y: number }[]) => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }
      return Math.abs(a) / 2;
    };
    expect(area(c90)).toBeCloseTo(area(c0), 9);
    // Jede Ecke von c0, um 90° CCW um `at`=(0,0) gedreht, muss in c90 wieder auftauchen.
    const rotated0 = c0.map((c) => ({ x: -c.y, y: c.x }));
    for (const r of rotated0) {
      expect(c90.some((c) => Math.abs(c.x - r.x) < 1e-9 && Math.abs(c.y - r.y) < 1e-9)).toBe(true);
    }
  });
});
