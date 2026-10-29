// Tests der Raum-Erkennung (Fassade über den Rust-Kern): Rechteck, Trennwand, Lücken, Klick-in-Raum.

import { describe, expect, it } from "vitest";
import type { Vec2 } from "../model/types";
import { detectRooms, type WallSegment } from "./roomBoundary";

const P = (x: number, y: number): Vec2 => ({ x, y });
const area = (pts: Vec2[]): number => {
  let s = 0;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  });
  return s / 2;
};

function box(w: number, h: number, t = 0.2): WallSegment[] {
  const c = [P(0, 0), P(w, 0), P(w, h), P(0, h)];
  return c.map((a, i) => ({ a, b: c[(i + 1) % 4], thickness: t }));
}

describe("detectRooms", () => {
  it("Rechteck: ein Raum, lichte Fläche, CCW", () => {
    const rooms = detectRooms(box(5, 4));
    expect(rooms).toHaveLength(1);
    expect(area(rooms[0])).toBeCloseTo(4.8 * 3.8, 9);
  });

  it("ohne Offset: Mittellinienfläche", () => {
    expect(area(detectRooms(box(5, 4), { offsetToInner: false })[0])).toBeCloseTo(20, 9);
  });

  it("Trennwand teilt in zwei Räume", () => {
    const walls = [...box(6, 4), { a: P(3, 0), b: P(3, 4), thickness: 0.2 }];
    const rooms = detectRooms(walls);
    expect(rooms).toHaveLength(2);
    for (const r of rooms) expect(area(r)).toBeCloseTo(2.8 * 3.8, 9);
  });

  it("kleine Lücke wird geschlossen, grosse nicht", () => {
    const open = (gap: number): WallSegment[] => [
      { a: P(0, 0), b: P(4, 0), thickness: 0 },
      { a: P(4, 0), b: P(4, 4), thickness: 0 },
      { a: P(4, 4), b: P(0, 4), thickness: 0 },
      { a: P(0, 4), b: P(0, gap), thickness: 0 },
    ];
    expect(detectRooms(open(0.03))).toHaveLength(1);
    expect(detectRooms(open(0.5))).toHaveLength(0);
  });

  it("zu wenige Wände, zu kleine Fläche, Unsinn: leer ohne Fehler", () => {
    expect(detectRooms(box(5, 4).slice(0, 2))).toEqual([]);
    expect(detectRooms(box(0.1, 0.1, 0))).toEqual([]);
    expect(detectRooms([])).toEqual([]);
    const bad = box(5, 4);
    bad[1] = { a: P(Number.NaN, 0), b: P(5, 4), thickness: 0.2 };
    expect(detectRooms(bad)).toEqual([]);
    expect(detectRooms(box(5, 4), { gapTol: Number.NaN })).toEqual([]);
  });
});
