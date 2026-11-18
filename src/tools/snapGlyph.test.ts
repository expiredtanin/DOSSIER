import { describe, expect, it } from "vitest";
import { snapGlyph, snapTipKey, snapTipText } from "./snapGlyph";
import type { SnapKind } from "./types";
import { PAPER_UNITS } from "./displayUnits";

describe("[288] Fangart → Symbol und Kurzhinweis", () => {
  it("jede wichtige Fangart hat ein eigenes Symbol", () => {
    const kinds: SnapKind[] = ["endpoint", "midpoint", "intersection", "perpendicular", "center", "onEdge"];
    const glyphs = kinds.map(snapGlyph);
    expect(glyphs).toEqual(["square", "triangle", "cross", "perp", "circle", "diamond"]);
    expect(new Set(glyphs).size).toBe(kinds.length);
    expect(snapGlyph("angle")).toBe("none");
  });

  it("Kurzhinweis über t() (de)", () => {
    const at = { x: 1, y: 2 };
    expect(snapTipText({ point: at, kind: "endpoint", distPx: 0 })).toBe("Endpunkt");
    expect(snapTipText({ point: at, kind: "midpoint", distPx: 0 })).toBe("Mitte");
    expect(snapTipText({ point: at, kind: "intersection", distPx: 0 })).toBe("Schnittpunkt");
    expect(snapTipText({ point: at, kind: "perpendicular", distPx: 0 })).toBe("Lot");
    expect(snapTipText({ point: at, kind: "onEdge", distPx: 0 })).toBe("Auf Kante");
    expect(snapTipKey("angle")).toBeNull();
  });

  it("Hilfslinien mit Abstand bzw. Richtung", () => {
    const refA = { x: 0, y: 0 };
    expect(snapTipText({ point: { x: 0, y: 2.5 }, refA, kind: "ortho", distPx: 0 })).toBe("Ortho 90° · 2.500m");
    expect(snapTipText({ point: { x: -1.25, y: 0 }, refA, kind: "extension", distPx: 0 })).toBe("Verlängerung · 1.250m");
    expect(snapTipText({ point: { x: 0.1, y: 0 }, refA, kind: "extension", distPx: 0 }, PAPER_UNITS)).toBe("Verlängerung · 100.0mm");
  });
});
