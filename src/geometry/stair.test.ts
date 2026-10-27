/**
 * `geometry/stair.ts` — Fassade über den Rust-Kern: Form-Prüfungen für gerade/L/Wendel,
 * Referenz, Schnitt, Rahmen und Unsinn-Eingaben (Rust-Tests decken die Mathematik je Fall ab).
 */
import { describe, it, expect } from "vitest";
import { defaultStepCount, stairBBox, stairCut, stairGeometry, stairOutline } from "./stair";
import type { Stair } from "../model/types";

const base: Stair = {
  id: "s", type: "stair", floorId: "eg", categoryCode: "40", shape: "straight",
  start: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, runLength: 3, width: 1.2, stepCount: 16,
};

describe("stairGeometry", () => {
  it("gerade: 16 Tritte, Setzstufe, Lauflinie, Pfeil nach oben", () => {
    const g = stairGeometry(base, 2.8);
    expect(g.treads).toHaveLength(16);
    expect(g.riserHeight).toBeCloseTo(0.175, 12);
    expect(g.landing).toBeNull();
    expect(g.treads[15].topRise).toBeCloseTo(2.8, 12);
    expect(g.arrow.head[1]).toEqual(g.runLine[1]);
    expect(stairGeometry({ ...base, up: false }, 2.8).arrow.head[1]).toEqual(g.runLine[0]);
  });

  it("L: Podest + zweiter Lauf, turn dreht die Richtung", () => {
    const l: Stair = { ...base, shape: "L", run2Length: 2 };
    const g = stairGeometry(l, 2.8);
    expect(g.treads).toHaveLength(15);
    expect(g.landing).toHaveLength(4);
    expect(g.runLine[2].y).toBeGreaterThan(1);
    expect(stairGeometry({ ...l, turn: -1 }, 2.8).runLine[2].y).toBeLessThan(-1);
  });

  it("Wendel: Keile, Auge mit 12 Punkten, Lauflinie als Bogen", () => {
    const sp: Stair = { ...base, shape: "spiral", center: { x: 0, y: 0 }, start: { x: 1, y: 0 }, radius: 1, stepCount: 12 };
    const g = stairGeometry(sp, 2.4);
    expect(g.treads).toHaveLength(12);
    expect(g.landing).toHaveLength(12);
    expect(g.runLine).toHaveLength(13);
  });

  it("Referenz links versetzt die Achse eine halbe Breite auf die Mitte", () => {
    const g = stairGeometry({ ...base, referenz: "links" }, 2.8);
    expect(g.treads[0].pts[0].y).toBeCloseTo(0, 12);
    expect(g.treads[0].pts[3].y).toBeCloseTo(-1.2, 12);
    expect(stairOutline({ ...base, referenz: "rechts" }, 0).polygon![0].y).toBeCloseTo(1.2, 12);
  });

  it("Unsinn (NaN, 0 Stufen) liefert leere bzw. Mindest-Geometrie ohne Fehler", () => {
    expect(stairGeometry({ ...base, width: NaN }, 2.8).treads).toEqual([]);
    expect(stairGeometry(base, NaN).treads).toEqual([]);
    expect(stairGeometry({ ...base, stepCount: 0 }, 2.8).treads).toHaveLength(2);
    expect(stairOutline({ ...base, runLength: NaN }, 0)).toEqual({ polygon: null, spiral: null });
    expect(stairBBox(stairGeometry(base, NaN))).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe("stairCut / stairBBox / defaultStepCount", () => {
  it("Schnitt teilt die Tritte und legt eine Doppel-Bruchlinie", () => {
    const g = stairGeometry(base, 2.8);
    const c = stairCut(g, 1.0);
    expect(c.belowIndices).toEqual([0, 1, 2, 3, 4]);
    expect(c.aboveIndices).toHaveLength(11);
    expect(c.breakLine).toHaveLength(2);
    expect(stairCut(g, 99).breakLine).toBeNull();
    expect(stairCut(stairGeometry(base, NaN), 1)).toEqual({ belowIndices: [], aboveIndices: [], breakLine: null });
  });

  it("BBox über Tritte", () => {
    const b = stairBBox(stairGeometry(base, 2.8));
    expect(b.maxX).toBeCloseTo(3, 12);
    expect(b.minY).toBeCloseTo(-0.6, 12);
  });

  it("Vorgabe-Stufenzahl: Steighöhe 0.17, gedeckelt durch die Lauflänge, mind. 2", () => {
    expect(defaultStepCount(2.8, 10)).toBe(16);
    expect(defaultStepCount(2.8, 3)).toBe(13);
    expect(defaultStepCount(0.1, 0)).toBe(2);
  });
});
