import { describe, expect, it } from "vitest";
import { bulgeArc, bulgeArcPoints } from "./bulge";
import { canSetVertexType, vertexTypeOf, withVertexType } from "./polylineVertexType";

const g = { pts: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 }, { x: 6, y: 1 }], closed: false };

describe("Punkttypen einer Polylinie", () => {
  it("Eckpunkt setzt beide Nachbarsegmente gerade", () => {
    const b = withVertexType({ ...g, bulge: [0.3, -0.2, 0.1] }, 1, "corner");
    expect(b).toEqual([0, 0, 0.1]);
  });

  it("Bogenpunkt: beide Segmente liegen auf EINEM Kreis durch die drei Punkte", () => {
    const b = withVertexType(g, 1, "arc");
    const a1 = bulgeArc(g.pts[0], g.pts[1], b[0])!;
    const a2 = bulgeArc(g.pts[1], g.pts[2], b[1])!;
    expect(a1).not.toBeNull();
    expect(Math.hypot(a1.center.x - a2.center.x, a1.center.y - a2.center.y)).toBeLessThan(1e-6);
    expect(a1.r).toBeCloseTo(a2.r, 6);
    expect(vertexTypeOf({ ...g, bulge: b }, 1)).toBe("arc");
    // Die Bögen bauchen NACH OBEN aus (Punkt 1 liegt oben) — kein Zickzack über den Kreis
    const mid1 = bulgeArcPoints(g.pts[0], g.pts[1], b[0]);
    const apex = mid1[mid1.length / 2 | 0];
    expect(apex.y).toBeGreaterThan(0.5);
  });

  it("Splinepunkt: Tangenten beider Segmente im Punkt stimmen überein", () => {
    const g = { pts: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 5, y: 0.2 }], closed: false };
    const b = withVertexType(g, 1, "spline");
    // exakte Tangenten aus den Bögen (senkrecht zum Radius, Richtung nach Umlaufsinn)
    const tan = (a: { x: number; y: number }, c: { x: number; y: number }, bb: number, atEnd: boolean) => {
      const arc = bulgeArc(a, c, bb)!;
      const ang = atEnd ? arc.a0 + arc.sweep : arc.a0;
      const sg = Math.sign(arc.sweep);
      return Math.atan2(Math.cos(ang) * sg, -Math.sin(ang) * sg);
    };
    const t1 = tan(g.pts[0], g.pts[1], b[0], true);
    const t2 = tan(g.pts[1], g.pts[2], b[1], false);
    expect(Math.abs(t1 - t2)).toBeLessThan(1e-6);
    // Tangente = Richtung Vorgänger→Nachfolger
    expect(Math.abs(t2 - Math.atan2(0.2, 5))).toBeLessThan(1e-6);
    expect(vertexTypeOf({ ...g, bulge: b }, 1)).toBe("spline");
  });

  it("offene Enden: Bogen/Spline nicht möglich, Ecke schon", () => {
    expect(canSetVertexType(g, 0, "arc")).toBe(false);
    expect(canSetVertexType(g, 3, "spline")).toBe(false);
    expect(canSetVertexType(g, 0, "corner")).toBe(true);
  });

  it("geschlossene Polylinie: erster Punkt hat beide Nachbarn", () => {
    const sq = { pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true };
    const b = withVertexType(sq, 0, "arc");
    expect(b.length).toBe(4);
    expect(b[3]).not.toBe(0);
    expect(b[0]).not.toBe(0);
    expect(b[1]).toBe(0);
  });
});
