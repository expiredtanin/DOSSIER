import { describe, expect, it } from "vitest";
import { cutMeshWithPlane, ringArea, ringsToPolygons } from "./meshSection";

/** Quader als geschlossenes Netz (12 Dreiecke, aussen orientiert). `inward` kehrt um (Hohlraum). */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, inward = false) {
  const p = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { p, f: inward ? f.map((_, i) => f[i - (i % 3) + [0, 2, 1][i % 3]]) : f };
}
const merge = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => ({ p: [...a.p, ...b.p], f: [...a.f, ...b.f.map((i) => i + a.p.length / 3)] });

describe("cutMeshWithPlane", () => {
  it("senkrechter Schnitt durch einen Quader: ein Ring, Fläche = Breite × Höhe", () => {
    const b = box(0, 0, 0, 4, 2, 3);
    const r = cutMeshWithPlane(b.p, b.f, { kind: "vertical", point: { x: 0, y: 1 }, dir: { x: 1, y: 0 } });
    expect(r.rings).toHaveLength(1);
    expect(r.lines).toHaveLength(0);
    expect(Math.abs(ringArea(r.rings[0]))).toBeCloseTo(4 * 3, 9);
  });

  it("waagrechter Schnitt: Grundriss-Ring (x,y)", () => {
    const b = box(1, 1, 0, 4, 3, 5);
    const r = cutMeshWithPlane(b.p, b.f, { kind: "horizontal", z: 2.5 });
    expect(r.rings).toHaveLength(1);
    expect(Math.abs(ringArea(r.rings[0]))).toBeCloseTo(3 * 2, 9);
  });

  it("Ebene exakt auf Ecken/Kanten (Raster!) schliesst trotzdem sauber", () => {
    const b = box(0, 0, 0, 4, 2, 3);
    for (const y of [0, 2]) {
      const r = cutMeshWithPlane(b.p, b.f, { kind: "vertical", point: { x: 0, y }, dir: { x: 1, y: 0 } });
      expect(r.lines).toHaveLength(0);
    }
    const r = cutMeshWithPlane(b.p, b.f, { kind: "horizontal", z: 3 });
    expect(r.lines).toHaveLength(0);
  });

  it("Ebene schneidet nicht: leer", () => {
    const b = box(0, 0, 0, 1, 1, 1);
    const r = cutMeshWithPlane(b.p, b.f, { kind: "horizontal", z: 10 });
    expect(r.rings).toEqual([]);
    expect(r.lines).toEqual([]);
  });

  it("Hohlkörper: Aussenring + Loch", () => {
    const m = merge(box(0, 0, 0, 10, 10, 10), box(3, 3, 3, 7, 7, 7, true));
    const r = cutMeshWithPlane(m.p, m.f, { kind: "horizontal", z: 5 });
    expect(r.rings).toHaveLength(2);
    const polys = ringsToPolygons(r.rings);
    expect(polys).toHaveLength(1);
    expect(polys[0]).toHaveLength(2);
    const area = Math.abs(ringArea(polys[0][0])) - Math.abs(ringArea(polys[0][1]));
    expect(area).toBeCloseTo(100 - 16, 9);
  });

  it("zwei getrennte Körper: zwei Polygone ohne Löcher", () => {
    const m = merge(box(0, 0, 0, 2, 2, 2), box(5, 0, 0, 7, 2, 2));
    const polys = ringsToPolygons(cutMeshWithPlane(m.p, m.f, { kind: "horizontal", z: 1 }).rings);
    expect(polys).toHaveLength(2);
    expect(polys.every((p) => p.length === 1)).toBe(true);
  });

  it("offenes Netz (Gelände): Linienzug statt Ring, Höhe als v", () => {
    // Zwei Dreiecke, die eine geneigte Fläche z = x bilden (x 0..4, y 0..4).
    const p = [0, 0, 0, 4, 0, 4, 4, 4, 4, 0, 4, 0];
    const f = [0, 1, 2, 0, 2, 3];
    const r = cutMeshWithPlane(p, f, { kind: "vertical", point: { x: 0, y: 2 }, dir: { x: 1, y: 0 } });
    expect(r.rings).toEqual([]);
    expect(r.lines).toHaveLength(1);
    const line = r.lines[0];
    const first = line[0];
    const last = line[line.length - 1];
    expect(Math.min(first[0], last[0])).toBeCloseTo(0, 9);
    expect(Math.max(first[0], last[0])).toBeCloseTo(4, 9);
    // v = z = u auf dieser Fläche
    for (const [u, v] of line) expect(v).toBeCloseTo(u, 9);
  });

  it("schräge Schnittrichtung", () => {
    const b = box(0, 0, 0, 2, 2, 2);
    const s = Math.SQRT1_2;
    const r = cutMeshWithPlane(b.p, b.f, { kind: "vertical", point: { x: 0, y: 0 }, dir: { x: s, y: s } });
    expect(r.rings).toHaveLength(1);
    // Diagonale des Quaders: Länge 2√2, Höhe 2
    expect(Math.abs(ringArea(r.rings[0]))).toBeCloseTo(2 * Math.SQRT2 * 2, 6);
  });
});
