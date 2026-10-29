import { describe, it, expect } from "vitest";
import { roofGeometry, roofUndersideAt } from "./roof";
import type { Roof, Vec2 } from "../model/types";

/** Bounding-Box eines Umrisses (Prüfhilfe). */
function roofBBox(outline: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

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

  it("mansarde giebel: Knick-Ratio parametriert die Knicklinien-Lage", () => {
    const g = roofGeometry(
      roof({ shape: "mansarde", mansardType: "giebel", mansardKneeRatio: 0.25 }),
      E,
    );
    // yf = y0 + halfD·ratio = 0 + 2·0.25 = 0.5.
    expect(g.breaks[0][0].y).toBeCloseTo(0.5, 6);
  });

  it("mansarde walm: allseitig geknickt -> 8 Flächen, 4 Knicklinien (Rechteck), 8 Grate, keine Giebel", () => {
    const g = roofGeometry(roof({ shape: "mansarde", mansardType: "walm" }), E);
    expect(g.planes).toHaveLength(8); // 4 Sockel + 2 Walm-Trapeze + 2 Walm-Dreiecke
    expect(g.breaks).toHaveLength(4); // inneres Knick-Rechteck
    expect(g.hips).toHaveLength(8); // 4 Sockel-Grate + 4 obere Walm-Grate
    expect(g.ridges).toHaveLength(1);
    expect(g.gables).toHaveLength(0); // Walm hat keine Giebel
    expect(g.ridgeHeight).toBeGreaterThan(0);
    // Knick-Höhe < First-Höhe (Sockel endet unter dem First).
    const kneeZ = g.planes[0].pts[2][2] - E; // z1 - e am inneren Punkt
    expect(kneeZ).toBeGreaterThan(0);
    expect(kneeZ).toBeLessThan(g.ridgeHeight);
  });

  it("mansarde zelt: allseitig geknickt zur Spitze -> 8 Flächen, kein First, 8 Grate", () => {
    const g = roofGeometry(roof({ shape: "mansarde", mansardType: "zelt" }), E);
    expect(g.planes).toHaveLength(8); // 4 Sockel + 4 Spitzen-Dreiecke
    expect(g.breaks).toHaveLength(4);
    expect(g.hips).toHaveLength(8);
    expect(g.ridges).toHaveLength(0); // Zelt hat keinen First
    expect(g.gables).toHaveLength(0);
    expect(g.ridgeHeight).toBeGreaterThan(0);
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

  it("getrennter Traufe/Ortgang-Überstand: First entlang X -> Ortgang weitet X, Traufe Y", () => {
    // ridgeAxis "x": First entlang X -> Ortgang (Giebel) an den X-Enden,
    // Traufe an den Y-Seiten. overhang(Traufe)=0.3, overhangGable(Ortgang)=0.8.
    const g = roofGeometry(
      roof({ shape: "sattel", ridgeAxis: "x", overhang: 0.3, overhangGable: 0.8 }),
      E,
    );
    const bb = roofBBox(g.eaves);
    expect(bb).toEqual({ x0: -0.8, y0: -0.3, x1: 6.8, y1: 4.3 });
  });

  it("getrennter Überstand: First entlang Y -> Ortgang weitet Y, Traufe X", () => {
    const g = roofGeometry(
      roof({ shape: "sattel", ridgeAxis: "y", overhang: 0.3, overhangGable: 0.8 }),
      E,
    );
    const bb = roofBBox(g.eaves);
    expect(bb).toEqual({ x0: -0.3, y0: -0.8, x1: 6.3, y1: 4.8 });
  });

  it("overhangGable fehlt -> ringsum gleich overhang (rückwärtskompatibel)", () => {
    const g = roofGeometry(roof({ shape: "sattel", overhang: 0.4 }), E);
    const bb = roofBBox(g.eaves);
    expect(bb).toEqual({ x0: -0.4, y0: -0.4, x1: 6.4, y1: 4.4 });
  });
});

describe("roofUndersideAt — Dach-Unterkante an einem Grundriss-Punkt", () => {
  // Sattel 6×4, First entlang X bei yc=2, Neigung 45° (tan=1) -> Firsthöhe 2.
  // Fläche 1 (y0=0..yc=2): z(x,y) = 10 + y (linear, unabhängig von x).
  const g = roofGeometry(roof({ shape: "sattel" }), E);

  it("an der Traufe (y=0): Oberkante 10, Unterkante minus Schichtdicke", () => {
    expect(roofUndersideAt(g, 0, 3, 0)).toBeCloseTo(10, 6);
    expect(roofUndersideAt(g, 0.2, 3, 0)).toBeCloseTo(9.8, 6);
  });

  it("am First (y=2): Oberkante 12 (Firsthöhe 10+2)", () => {
    expect(roofUndersideAt(g, 0, 3, 2)).toBeCloseTo(12, 6);
  });

  it("interpoliert linear zwischen Traufe und First (y=1 -> 11)", () => {
    expect(roofUndersideAt(g, 0, 3, 1)).toBeCloseTo(11, 6);
  });

  it("ausserhalb des Dach-Umrisses -> null", () => {
    expect(roofUndersideAt(g, 0, 3, -1)).toBeNull();
    expect(roofUndersideAt(g, 0, 8, 1)).toBeNull();
  });

  it("negative/fehlende Schichtdicke wird auf 0 geklemmt (keine Anhebung)", () => {
    expect(roofUndersideAt(g, -0.5, 3, 0)).toBeCloseTo(10, 6);
  });
});
