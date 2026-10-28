import { describe, expect, it } from "vitest";
import type { Vec2 } from "../model/types";
import { straightSkeleton, type SkeletonPoint } from "./skeleton";

const v = (pts: [number, number][]): Vec2[] => pts.map(([x, y]) => ({ x, y }));
const area = (loop: { x: number; y: number }[]) => {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

describe("straightSkeleton (Rust-Kern)", () => {
  it("Hof: acht Trapeze bis zum Firstring, Fläche = Grundriss minus Hof", () => {
    const rings = [v([[0, 0], [12, 0], [12, 12], [0, 12]]), v([[4, 4], [4, 8], [8, 8], [8, 4]])];
    const r = straightSkeleton(rings, Array(8).fill(1));
    expect("faces" in r).toBe(true);
    if (!("faces" in r)) return;
    expect(r.faces.map((f) => f.length)).toEqual(Array(8).fill(1));
    const total = r.faces.flat().reduce((s, l) => s + area(l), 0);
    expect(total).toBeCloseTo(128, 9);
    const top = Math.max(...r.faces.flat(2).map((p: SkeletonPoint) => p.t));
    expect(top).toBeCloseTo(2, 9);
  });

  it("Neigung je Kante: schnellere Südkante schiebt den First nach Norden", () => {
    const r = straightSkeleton([v([[0, 0], [10, 0], [10, 4], [0, 4]])], [2, 0, 1, 0]);
    if (!("faces" in r)) throw new Error(r.error);
    expect(r.faces[1]).toEqual([]);
    expect(r.faces[0][0].some((p) => Math.abs(p.y - 8 / 3) < 1e-9)).toBe(true);
  });

  it("Fehler statt Ausnahme", () => {
    expect(straightSkeleton([], [])).toEqual({ error: "input" });
    expect(straightSkeleton([v([[0, 0], [1, 0], [1, 1], [0, 1]])], [0, 0, 0, 0])).toEqual({ error: "noSlope" });
    expect(straightSkeleton([v([[0, 0], [12, 0], [12, 9], [8, 9], [8, 4], [4, 4], [4, 9], [0, 9]])], Array(8).fill(1), 1)).toEqual({ error: "budget" });
    expect(straightSkeleton([v([[0, 0], [NaN, 0], [1, 1]])], [1, 1, 1])).toEqual({ error: "input" });
  });
});
