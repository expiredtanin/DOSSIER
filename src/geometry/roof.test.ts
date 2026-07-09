import { describe, it, expect } from "vitest";
import { roofGeometry, roofBBox } from "./roof";
import type { Roof, Vec2 } from "../model/types";

// Rechteck 6×4 (x:0..6, y:0..4), Neigung 45° (tan=1), Traufhöhe 10, kein Überstand.
const RECT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 4 },
  { x: 0, y: 4 },
];
const E = 10;

function roof(over: Partial<Roof>): Roof {
  return {
    id: "R1",
    type: "roof",
    floorId: "eg",
    categoryCode: "35",
    outline: RECT,
    shape: "sattel",
    pitchDeg: 45,
    overhang: 0,
    ridgeAxis: "x",
    thickness: 0.2,
    ...over,
  };
}

/** Alle 3D-Punkte einer Geometrie (Flächen + Giebel). */
function allZ(g: ReturnType<typeof roofGeometry>): number[] {
  const zs: number[] = [];
  for (const pl of g.planes) for (const p of pl.pts) zs.push(p[2]);
  for (const gp of g.gables) for (const p of gp) zs.push(p[2]);
  return zs;
}

describe("roofBBox", () => {
  it("liefert die Bounding-Box", () => {
    expect(roofBBox(RECT)).toEqual({ x0: 0, y0: 0, x1: 6, y1: 4 });
  });
});

describe("roofGeometry — Formen (6×4, 45°, First entlang X)", () => {
  it("flach: eine waagrechte Fläche auf Traufhöhe, kein First", () => {
    const g = roofGeometry(roof({ shape: "flach" }), E);
    expect(g.planes).toHaveLength(1);
    expect(g.ridges).toHaveLength(0);
    expect(g.ridgeHeight).toBe(0);
    expect(allZ(g).every((z) => z === E)).toBe(true);
  });

  it("sattel: Firsthöhe = halbe Tiefe · tan, First mittig, 2 Flächen + 2 Giebel", () => {
    const g = roofGeometry(roof({ shape: "sattel" }), E);
    expect(g.ridgeHeight).toBeCloseTo(2, 6); // halfD 2 · tan45 1
    expect(g.planes).toHaveLength(2);
    expect(g.gables).toHaveLength(2);
    expect(g.ridges).toHaveLength(1);
    // First auf yc=2, z=E+2.
    expect(g.ridges[0][0]).toEqual({ x: 0, y: 2 });
    expect(g.ridges[0][1]).toEqual({ x: 6, y: 2 });
    expect(Math.max(...allZ(g))).toBeCloseTo(E + 2, 6);
    expect(Math.min(...allZ(g))).toBeCloseTo(E, 6);
  });

  it("walm: First um halbe Tiefe verkürzt, 4 Flächen, 4 Grate, keine Giebel", () => {
    const g = roofGeometry(roof({ shape: "walm" }), E);
    expect(g.planes).toHaveLength(4);
    expect(g.hips).toHaveLength(4);
    expect(g.gables).toHaveLength(0);
    // ra=2, rb=4.
    expect(g.ridges[0][0]).toEqual({ x: 2, y: 2 });
    expect(g.ridges[0][1]).toEqual({ x: 4, y: 2 });
    expect(g.ridgeHeight).toBeCloseTo(2, 6);
  });

  it("zelt: Spitze über der Mitte, 4 Flächen, 4 Grate zur Mitte", () => {
    const g = roofGeometry(roof({ shape: "zelt" }), E);
    expect(g.planes).toHaveLength(4);
    expect(g.hips).toHaveLength(4);
    expect(g.ridges).toHaveLength(0);
    // hz = min(halfW 3, halfD 2)=2.
    expect(g.ridgeHeight).toBeCloseTo(2, 6);
    // Alle Grate laufen zum Mittelpunkt (3,2).
    for (const hip of g.hips) expect(hip[1]).toEqual({ x: 3, y: 2 });
  });

  it("pult: eine Fläche, hohe Kante = Breite·tan über der Traufe", () => {
    const g = roofGeometry(roof({ shape: "pult" }), E);
    expect(g.planes).toHaveLength(1);
    expect(g.ridgeHeight).toBeCloseTo(4, 6); // Tiefe 4 · tan45
    expect(Math.max(...allZ(g))).toBeCloseTo(E + 4, 6);
  });

  it("mansarde: 4 Flächen, 2 Knicklinien, First mittig, Knick tiefer als First", () => {
    const g = roofGeometry(roof({ shape: "mansarde", pitchDeg: 70, pitchUpperDeg: 30 }), E);
    expect(g.planes).toHaveLength(4);
    expect(g.breaks).toHaveLength(2);
    expect(g.ridges).toHaveLength(1);
    expect(g.gables).toHaveLength(2); // Pentagon-Giebel
    // First höher als 0, Knicklinien innerhalb der Tiefe.
    expect(g.ridgeHeight).toBeGreaterThan(0);
    expect(g.breaks[0][0].y).toBeCloseTo(0 + 2 * 0.4, 6); // yf = y0 + halfD·0.4
  });
});

describe("roofGeometry — First entlang Y (Transponierung)", () => {
  it("dreht die Sattel-First-Linie auf die X-Mitte", () => {
    const g = roofGeometry(roof({ shape: "sattel", ridgeAxis: "y" }), E);
    // Firstrichtung Y → First liegt bei x = xc = 3, läuft in Y.
    expect(g.ridges[0][0]).toEqual({ x: 3, y: 0 });
    expect(g.ridges[0][1]).toEqual({ x: 3, y: 4 });
    // Firsthöhe nun aus der halben BREITE (3) · tan = 3.
    expect(g.ridgeHeight).toBeCloseTo(3, 6);
  });
});

describe("roofGeometry — Überstand", () => {
  it("weitet die Traufe um overhang nach aussen", () => {
    const g = roofGeometry(roof({ shape: "flach", overhang: 0.5 }), E);
    const bb = roofBBox(g.eaves);
    expect(bb).toEqual({ x0: -0.5, y0: -0.5, x1: 6.5, y1: 4.5 });
  });
});
