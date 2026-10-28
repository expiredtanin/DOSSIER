// Basismengen für den IFC-Export ([B5], 28.10.): reine Rechnung aus der Geometrie, Werte nachrechenbar.
import { describe, it, expect } from "vitest";
import type { RWall } from "../plan/toWalls3d";
import {
  columnQuantities,
  flightQuantities,
  meshVolume,
  openingQuantities,
  railingQuantities,
  ringArea,
  ringPerimeter,
  roofQuantities,
  slabQuantities,
  wallQuantities,
} from "./ifcQuantities";

const byName = (q: { name: string; value: number }[]) => Object.fromEntries(q.map((x) => [x.name, x.value]));

/** Wandband: Quader `len` lang entlang x ab `x0`, Dicke, Höhe ab `base`. */
function band(x0: number, len: number, thickness: number, height: number, base = 0, topDrop?: [number, number]): RWall {
  return { start: [x0, 0], end: [x0 + len, 0], thickness, height, baseElevation: base, color: [1, 1, 1], layers: [], wallId: "W", ...(topDrop ? { topDrop } : {}) };
}

describe("Hilfen", () => {
  it("Ringfläche (unabhängig vom Umlaufsinn) und Umfang", () => {
    const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
    expect(ringArea(sq)).toBe(12);
    expect(ringArea([...sq].reverse())).toBe(12);
    expect(ringPerimeter(sq)).toBe(14);
    expect(ringArea([])).toBe(0);
  });

  it("Mesh-Volumen eines Würfels, unabhängig von der Wicklung", () => {
    const pos = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2];
    const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    expect(meshVolume(pos, idx)).toBeCloseTo(8, 12);
    const rev: number[] = [];
    for (let i = 0; i < idx.length; i += 3) rev.push(idx[i], idx[i + 2], idx[i + 1]);
    expect(meshVolume(pos, rev)).toBeCloseTo(8, 12);
    expect(meshVolume([], [])).toBe(0);
  });
});

describe("Wand", () => {
  const wall = { start: { x: 0, y: 0 }, end: { x: 5, y: 0 } };

  it("eine Schicht: Länge, Dicke, Höhe, Seitenfläche, Volumen; Öffnung wird netto abgezogen", () => {
    const q = byName(
      wallQuantities(wall, [band(0, 5, 0.3, 2.6)], [{ from: 1, to: 2, zBottom: 0.9, zTop: 2.1 }]),
    );
    expect(q.Length).toBe(5);
    expect(q.Width).toBeCloseTo(0.3, 12);
    expect(q.Height).toBeCloseTo(2.6, 12);
    expect(q.GrossSideArea).toBeCloseTo(13, 12);
    expect(q.NetSideArea).toBeCloseTo(13 - 1.2, 12);
    expect(q.GrossVolume).toBeCloseTo(13 * 0.3, 12);
    expect(q.NetVolume).toBeCloseTo((13 - 1.2) * 0.3, 12);
  });

  it("mehrere Schichten: Dicke und Volumen summieren, Öffnung schneidet jede Schicht", () => {
    // Aussenschicht 0.2 (Achse −0.15 … ), Dämmung 0.1: Mittellinien bei y = −0.05 und +0.1
    const a = { ...band(0, 5, 0.2, 2.6), start: [0, -0.05], end: [5, -0.05] } as RWall;
    const b = { ...band(0, 5, 0.1, 2.6), start: [0, 0.1], end: [5, 0.1] } as RWall;
    const q = byName(wallQuantities(wall, [a, b], [{ from: 2, to: 3, zBottom: 0, zTop: 2.1 }]));
    expect(q.Width).toBeCloseTo(0.3, 12);
    expect(q.GrossVolume).toBeCloseTo(5 * 0.3 * 2.6, 12);
    expect(q.NetVolume).toBeCloseTo((5 * 2.6 - 1 * 2.1) * 0.3, 12);
  });

  it("innere Schicht endet unter der Decke: Seitenfläche mit voller Wandhöhe, Volumen je Schicht", () => {
    const outer = band(0, 5, 0.2, 2.6);
    const inner = band(0.1, 4.8, 0.1, 2.3);
    const q = byName(wallQuantities(wall, [outer, inner], []));
    expect(q.Height).toBeCloseTo(2.6, 12);
    expect(q.GrossSideArea).toBeCloseTo(13, 12);
    expect(q.GrossVolume).toBeCloseTo(5 * 0.2 * 2.6 + 4.8 * 0.1 * 2.3, 12);
  });

  it("Gehrung/Anschluss: kürzeres Band ändert Volumen, nicht die Wandlänge", () => {
    const q = byName(wallQuantities(wall, [band(0.1, 4.8, 0.3, 2.6)], []));
    expect(q.Length).toBe(5);
    expect(q.GrossVolume).toBeCloseTo(4.8 * 0.3 * 2.6, 12);
    expect(q.NetVolume).toBeCloseTo(q.GrossVolume, 12);
  });

  it("schräge Oberkante: Höhe fehlt (nicht konstant), Fläche und Volumen mit mittlerer Höhe", () => {
    const q = byName(wallQuantities(wall, [band(0, 5, 0.3, 3, 0, [0, 1])], []));
    expect(q.Height).toBeUndefined();
    expect(q.GrossSideArea).toBeCloseTo(5 * 2.5, 12);
    expect(q.GrossVolume).toBeCloseTo(5 * 0.3 * 2.5, 12);
  });

  it("Mesh-Wand: Netto-Volumen aus dem Netz, Brutto bleibt der Quader", () => {
    const q = byName(wallQuantities(wall, [band(0, 5, 0.3, 2.6)], [{ from: 1, to: 2, zBottom: 0.9, zTop: 2.1 }], 3.5));
    expect(q.NetVolume).toBe(3.5);
    expect(q.GrossVolume).toBeCloseTo(13 * 0.3, 12);
  });

  it("Öffnung grösser als die Wand: Netto nie negativ; Öffnung ausserhalb zieht nichts ab", () => {
    const q = byName(wallQuantities(wall, [band(0, 5, 0.3, 2.6)], [{ from: -1, to: 6, zBottom: -1, zTop: 5 }, { from: 8, to: 9, zBottom: 0, zTop: 2 }]));
    expect(q.NetSideArea).toBe(0);
    expect(q.NetVolume).toBeCloseTo(0, 12);
  });

  it("keine Bänder: keine Mengen", () => {
    expect(wallQuantities(wall, [], [])).toEqual([]);
  });
});

describe("Decke, Dach, Stütze, Öffnung, Treppe", () => {
  it("Decke: Fläche, Umfang, Dicke; Aussparung nur netto", () => {
    const outline = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }];
    const hole = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }];
    const q = byName(slabQuantities(outline, [hole], 0.2));
    expect(q.Width).toBeCloseTo(0.2, 12);
    expect(q.Perimeter).toBe(18);
    expect(q.GrossArea).toBe(20);
    expect(q.NetArea).toBe(19);
    expect(q.GrossVolume).toBeCloseTo(4, 12);
    expect(q.NetVolume).toBeCloseTo(3.8, 12);
  });

  it("Dach: geneigte Fläche > Grundrissfläche (Satteldach 30°)", () => {
    // Zwei Flächen 5 × 2 m Grundriss, 30° geneigt: je 5 × 2/cos(30°).
    const h = Math.tan(Math.PI / 6) * 2;
    const planes = [
      [[0, 0, 0], [5, 0, 0], [5, 2, h], [0, 2, h]],
      [[0, 4, 0], [0, 2, h], [5, 2, h], [5, 4, 0]],
    ] as [number, number, number][][];
    const q = byName(roofQuantities(planes));
    expect(q.ProjectedArea).toBeCloseTo(20, 9);
    expect(q.GrossArea).toBeCloseTo(20 / Math.cos(Math.PI / 6), 9);
    expect(q.NetArea).toBe(q.GrossArea);
  });

  it("Stütze 0.3 × 0.3 × 2.6", () => {
    const fp = [{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.3 }, { x: 0, y: 0.3 }];
    const q = byName(columnQuantities(fp, 2.6));
    expect(q.Length).toBe(2.6);
    expect(q.CrossSectionArea).toBeCloseTo(0.09, 12);
    expect(q.OuterSurfaceArea).toBeCloseTo(1.2 * 2.6, 12);
    expect(q.NetSurfaceArea).toBeCloseTo(1.2 * 2.6 + 0.18, 12);
    expect(q.GrossVolume).toBeCloseTo(0.09 * 2.6, 12);
    expect(q.NetVolume).toBeCloseTo(q.GrossVolume, 12);
  });

  it("Fenster/Tür: Breite, Höhe, Umfang, Fläche", () => {
    const q = byName(openingQuantities(1.2, 1.5));
    expect(q.Width).toBe(1.2);
    expect(q.Height).toBe(1.5);
    expect(q.Perimeter).toBeCloseTo(5.4, 12);
    expect(q.Area).toBeCloseTo(1.8, 12);
  });

  it("Lauf und Geländer", () => {
    expect(byName(flightQuantities(3.4, 1.2))).toEqual({ Length: 3.4, GrossVolume: 1.2, NetVolume: 1.2 });
    expect(byName(railingQuantities(5))).toEqual({ Length: 5 });
  });

  it("nie NaN/negativ: kaputte Eingaben ergeben 0", () => {
    const q = openingQuantities(Number.NaN, -1);
    for (const x of q) expect(Number.isFinite(x.value) && x.value >= 0).toBe(true);
  });
});
