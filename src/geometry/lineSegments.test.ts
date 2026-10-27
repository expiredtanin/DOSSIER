// Modulares Linien-Segment-System: Abbildung Segmentliste ↔ dash-Array,
// Punkt-Erkennung (Round-Cap) und die Schnell-Presets.

import { describe, it, expect } from "vitest";
import {
  segmentsToDash,
  dashToSegments,
  dashHasDot,
  presetOfDash,
  LINE_PRESETS,
  type LineSegment,
} from "./lineSegments";

describe("segmentsToDash", () => {
  it("bildet eine alternierende Strich/Lücke-Folge direkt ab", () => {
    const segs: LineSegment[] = [
      { type: "dash", length: 2 },
      { type: "gap", length: 1 },
      { type: "dash", length: 3 },
      { type: "gap", length: 2 },
    ];
    expect(segmentsToDash(segs)).toEqual([2, 1, 3, 2]);
  });

  it("bildet einen Punkt als 0-Länge ab (Strich-Punkt)", () => {
    const segs: LineSegment[] = [
      { type: "dash", length: 4 },
      { type: "gap", length: 2 },
      { type: "dot", length: 0 },
      { type: "gap", length: 2 },
    ];
    expect(segmentsToDash(segs)).toEqual([4, 2, 0, 2]);
  });

  it("fügt eine 0-Lücke zwischen zwei AN-Segmenten ein (Strich·Punkt)", () => {
    const segs: LineSegment[] = [
      { type: "dash", length: 3 },
      { type: "dot", length: 0 },
    ];
    // 3 (Strich), 0 (eingefügte Lücke), 0 (Punkt), 0 (Schluss-Lücke, gerade Länge)
    expect(segmentsToDash(segs)).toEqual([3, 0, 0, 0]);
  });

  it("fasst zwei Lücken in Folge zusammen", () => {
    const segs: LineSegment[] = [
      { type: "dash", length: 2 },
      { type: "gap", length: 1 },
      { type: "gap", length: 2 },
    ];
    expect(segmentsToDash(segs)).toEqual([2, 3]);
  });

  it("endet stets auf einer AUS-Länge (gerade Array-Länge)", () => {
    expect(segmentsToDash([{ type: "dash", length: 5 }])).toEqual([5, 0]);
  });

  it("leere Folge ⇒ null (Volllinie)", () => {
    expect(segmentsToDash([])).toBeNull();
  });
});

describe("dashToSegments", () => {
  it("kehrt die Abbildung um (0 ⇒ Punkt)", () => {
    expect(dashToSegments([4, 2, 0, 2])).toEqual([
      { type: "dash", length: 4 },
      { type: "gap", length: 2 },
      { type: "dot", length: 0 },
      { type: "gap", length: 2 },
    ]);
  });

  it("null ⇒ leere Folge", () => {
    expect(dashToSegments(null)).toEqual([]);
  });

  it("round-trip: dash → segments → dash bleibt stabil", () => {
    for (const d of [[2, 1, 3, 2], [4, 2, 0, 2], [0, 2], [3, 2]]) {
      expect(segmentsToDash(dashToSegments(d))).toEqual(d);
    }
  });
});

describe("dashHasDot", () => {
  it("erkennt Punkte (0 im dash) für die runde Kappe", () => {
    expect(dashHasDot([0, 2])).toBe(true);
    expect(dashHasDot([4, 2, 0, 2])).toBe(true);
  });
  it("keine Punkte ⇒ false (Butt-Kappe bleibt)", () => {
    expect(dashHasDot([3, 2])).toBe(false);
    expect(dashHasDot(null)).toBe(false);
    expect(dashHasDot([])).toBe(false);
  });
});

describe("Presets", () => {
  it("die vier Grundtypen sind erkennbar", () => {
    expect(presetOfDash(LINE_PRESETS.solid)).toBe("solid");
    expect(presetOfDash(LINE_PRESETS.dash)).toBe("dash");
    expect(presetOfDash(LINE_PRESETS.dot)).toBe("dot");
    expect(presetOfDash(LINE_PRESETS.dashDot)).toBe("dashDot");
  });
  it("Punktlinie/Strich-Punkt enthalten einen Dot, Voll/Strich nicht", () => {
    expect(dashHasDot(LINE_PRESETS.dot)).toBe(true);
    expect(dashHasDot(LINE_PRESETS.dashDot)).toBe(true);
    expect(dashHasDot(LINE_PRESETS.solid)).toBe(false);
    expect(dashHasDot(LINE_PRESETS.dash)).toBe(false);
  });
  it("Abweichungen ⇒ custom", () => {
    expect(presetOfDash([1, 2, 3, 4])).toBe("custom");
  });
});
