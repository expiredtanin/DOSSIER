import { describe, expect, it } from "vitest";
import { nearestPolylineTarget, toleranceFor } from "./polylinePoint";

const L = {
  pts: [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 3 },
  ],
  closed: false,
};

describe("nearestPolylineTarget", () => {
  it("nahe an einem Eckpunkt → Eckpunkt (gewinnt gegen die anliegenden Segmente)", () => {
    const hit = nearestPolylineTarget(L, { x: 4.02, y: 0.02 }, 0.5);
    expect(hit).toMatchObject({ kind: "vertex", index: 1 });
  });

  it("mitten auf einem Segment → Segment samt Lotfusspunkt", () => {
    const hit = nearestPolylineTarget(L, { x: 2, y: 0.1 }, 0.5);
    expect(hit).toMatchObject({ kind: "segment", segIndex: 0 });
    if (hit?.kind === "segment") {
      expect(hit.at.x).toBeCloseTo(2, 9);
      expect(hit.at.y).toBeCloseTo(0, 9);
    }
  });

  it("ausserhalb der Toleranz → null (keine Überraschungs-Aktion im Menü)", () => {
    expect(nearestPolylineTarget(L, { x: 2, y: 9 }, 0.5)).toBeNull();
  });

  it("offene Polylinie hat KEIN Schluss-Segment, geschlossene schon", () => {
    const p = { x: 2, y: 1.5 };
    expect(nearestPolylineTarget(L, p, 0.3)).toBeNull();
    const closed = nearestPolylineTarget({ ...L, closed: true }, p, 0.3);
    expect(closed).toMatchObject({ kind: "segment", segIndex: 2 });
  });
});

describe("toleranceFor", () => {
  it("skaliert mit der Grösse des Elements, mit sinnvoller Untergrenze", () => {
    expect(toleranceFor(L)).toBeCloseTo(0.1, 9); // Diagonale 5 m × 2 %
    const tiny = { pts: [{ x: 0, y: 0 }, { x: 0.1, y: 0 }], closed: false };
    expect(toleranceFor(tiny)).toBe(0.05);
  });
});
