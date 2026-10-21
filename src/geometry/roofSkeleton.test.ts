import { describe, expect, it } from "vitest";
import type { Roof, Vec2 } from "../model/types";
import { roofGeometry } from "./roof";
import { convexPieces, isRectilinearNonRect, rectilinearHipRoof } from "./roofSkeleton";

const L: Vec2[] = [{ x: 0, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 6 }, { x: 0, y: 6 }];

const planArea = (pts: number[][]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
};

describe("rectilinearHipRoof (L-Grundriss)", () => {
  const r = rectilinearHipRoof(L, 1, 0);
  it("Flächen decken den Grundriss exakt (44 + 18 = 62 m² … L = 11·4 + 8·2)", () => {
    const total = r.planes.reduce((s, p) => s + planArea(p), 0);
    expect(total).toBeCloseTo(11 * 4 + 8 * 2, 6);
  });
  it("alle Flächen konvex, Höhe = Abstand zur Traufe, Firsthöhe 3 m (halbe Breite 6 → Flügel 4 m: 2 m … )", () => {
    for (const p of r.planes) expect(convexPieces(p.map(([x, y]) => ({ x, y }))).length).toBe(1);
    expect(r.ridgeHeight).toBeCloseTo(3, 6);
  });
  it("Kehle: einspringende Ecke (8,4) steigt zum Kehlpunkt (6,2)", () => {
    expect(r.hips.some(([a, b]) => (a.x === 8 && a.y === 4 && b.x === 6 && b.y === 2) || (b.x === 8 && b.y === 4 && a.x === 6 && a.y === 2))).toBe(true);
  });
});

describe("roofGeometry", () => {
  const base = { id: "R", type: "roof", floorId: "eg", categoryCode: "31", outline: L, shape: "walm", pitchDeg: 45, overhang: 0, ridgeAxis: "x" } as unknown as Roof;
  it("Walm auf L nutzt das Skelett, Rechteck bleibt Bounding-Box", () => {
    expect(isRectilinearNonRect(L)).toBe(true);
    expect(roofGeometry(base, 0).planes.length).toBe(8);
    const rect = { ...base, outline: L.slice(0, 1).concat([{ x: 11, y: 0 }, { x: 11, y: 6 }, { x: 0, y: 6 }]) };
    expect(roofGeometry(rect, 0).planes.length).toBe(4);
  });
});

describe("Satteldach auf L-Grundriss", () => {
  const r = rectilinearHipRoof(L, 1, 0, "x");
  it("Flächen decken den Grundriss, Giebel statt Walm-Schrägen", () => {
    const total = r.planes.reduce((s, p) => s + planArea(p), 0);
    expect(total).toBeCloseTo(11 * 4 + 8 * 2, 6);
    expect(r.gables.length).toBe(3);
  });
  it("Giebel am Ende x=0 reicht bis zum First (halbe Tiefe 3 m)", () => {
    const g = r.gables.find((poly) => poly.every((v) => v[0] === 0))!;
    expect(Math.max(...g.map((v) => v[2]))).toBeCloseTo(3, 6);
  });
});

describe("Satteldach, First entlang y", () => {
  it("gedrehter L-Grundriss liefert dieselbe Flächensumme und Giebel quer zu y", () => {
    const Lt = L.map((p) => ({ x: p.y, y: p.x }));
    const r = rectilinearHipRoof(Lt, 1, 0, "y");
    expect(r.planes.reduce((s, p) => s + planArea(p), 0)).toBeCloseTo(11 * 4 + 8 * 2, 6);
    expect(r.gables.length).toBe(3);
  });
});

describe("Satteldach auf L: Ortgang-Überstand", () => {
  it("overhangGable verschiebt nur die Giebelkanten", () => {
    const roof = { id: "R", type: "roof", floorId: "eg", categoryCode: "31", outline: L, shape: "sattel", pitchDeg: 45, overhang: 0.5, overhangGable: 1, ridgeAxis: "x" } as unknown as Roof;
    const xs = roofGeometry(roof, 0).eaves.map((p) => p.x);
    const ys = roofGeometry(roof, 0).eaves.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-1, 6);
    expect(Math.max(...xs)).toBeCloseTo(12, 6);
    expect(Math.min(...ys)).toBeCloseTo(-0.5, 6);
    expect(Math.max(...ys)).toBeCloseTo(6.5, 6);
  });
});

describe("Pultdach auf L-Grundriss", () => {
  const roof = { id: "R", type: "roof", floorId: "eg", categoryCode: "31", outline: L, shape: "pult", pitchDeg: 45, overhang: 0, ridgeAxis: "x" } as unknown as Roof;
  it("eine Ebene über dem Umriss: Fläche = Grundriss, Höhe steigt mit y bis 6 m", () => {
    const g = roofGeometry(roof, 0);
    expect(g.planes.reduce((s, p) => s + planArea(p.pts), 0)).toBeCloseTo(11 * 4 + 8 * 2, 6);
    expect(g.ridgeHeight).toBeCloseTo(6, 6);
    for (const pl of g.planes) for (const v of pl.pts) expect(v[2]).toBeCloseTo(v[1], 6);
    expect(g.gables.length).toBe(3);
  });
});

describe("Mansarde auf L-Grundriss", () => {
  const roof = { id: "R", type: "roof", floorId: "eg", categoryCode: "31", outline: L, shape: "mansarde", mansardType: "giebel", pitchDeg: 45, pitchUpperDeg: 0, mansardKneeRatio: 0.4, overhang: 0, ridgeAxis: "x" } as unknown as Roof;
  it("Flächen decken den Grundriss, oben flach auf Knickhöhe", () => {
    const g = roofGeometry(roof, 0);
    expect(g.planes.reduce((s, p) => s + planArea(p.pts), 0)).toBeCloseTo(11 * 4 + 8 * 2, 6);
    expect(g.ridgeHeight).toBeCloseTo(1.2, 6); // Tiefe 3 · 0,4 · tan45
    expect(g.breaks.length).toBeGreaterThan(0);
  });
});
