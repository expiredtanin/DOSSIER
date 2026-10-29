/**
 * Rahmen-Auswahl über Decken/Räume/Treppen (`PlanPickIndex.marquee`) — Nutzer-Report:
 * "Auswahlrahmen kann nicht alle Elemente anwählen, z.B. Decken, Räume und
 * Treppen nicht". Vorher las das Auswahl-Rechteck nur `wallId`/`drawingId`
 * aus den Polygon-Primitiven; die anderen ID-Felder (die dieselben
 * Primitive längst tragen) wurden ignoriert.
 */

import { describe, it, expect } from "vitest";
import type { Primitive } from "../generatePlan";
import type { ModelRect } from "./geometry";
import { PlanPickIndex } from "./planPick";

// Rahmen-Auswahl im Kern ([K3d], `plan_pick.rs`) über einen Plan aus diesen Primitiven.
type Field = "wallId" | "ceilingId" | "roomId" | "stairId";
const hit = (field: Field) => (prims: Primitive[], rect: ModelRect, crossing: boolean): string[] => {
  const ix = new PlanPickIndex({ primitives: prims, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });
  try {
    return ix.marquee(field, rect, crossing);
  } finally {
    ix.release();
  }
};
const marqueeHit = hit("wallId");
const marqueeHitCeilings = hit("ceilingId");
const marqueeHitRooms = hit("roomId");
const marqueeHitStairs = hit("stairId");

const NO_HATCH = { pattern: "none" as const, color: "#000" };

function poly(id: Partial<Record<"wallId" | "ceilingId" | "roomId" | "stairId", string>>, pts: { x: number; y: number }[]): Primitive {
  return {
    kind: "polygon",
    pts,
    fill: "none",
    stroke: "#000",
    strokeWidthMm: 0.18,
    hatch: NO_HATCH,
    ...id,
  } as Primitive;
}

const square = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

describe("Marquee — Decken/Räume/Treppen", () => {
  it("marqueeHitCeilings findet eine vollständig eingeschlossene Decke (window)", () => {
    const prims = [poly({ ceilingId: "c1" }, square(1, 1, 3, 3))];
    const rect = { minX: 0, minY: 0, maxX: 5, maxY: 5 };
    expect(marqueeHitCeilings(prims, rect, false)).toEqual(["c1"]);
  });

  it("marqueeHitRooms ignoriert einen Raum, der nur teilweise im Fenster liegt (window, kein crossing)", () => {
    const prims = [poly({ roomId: "r1" }, square(1, 1, 10, 10))];
    const rect = { minX: 0, minY: 0, maxX: 5, maxY: 5 };
    expect(marqueeHitRooms(prims, rect, false)).toEqual([]);
    // Dieselbe Geometrie im Crossing-Modus (rechts→links) trifft trotzdem.
    expect(marqueeHitRooms(prims, rect, true)).toEqual(["r1"]);
  });

  it("marqueeHitStairs findet eine Treppe über mehrere Tritt-Polygone (alle müssen im Fenster liegen)", () => {
    const prims = [
      poly({ stairId: "s1" }, square(1, 1, 2, 2)),
      poly({ stairId: "s1" }, square(2, 1, 3, 2)),
    ];
    const rect = { minX: 0, minY: 0, maxX: 5, maxY: 5 };
    expect(marqueeHitStairs(prims, rect, false)).toEqual(["s1"]);
  });

  it("Wände (marqueeHit) und Decken/Räume/Treppen sind unabhängig voneinander auswertbar", () => {
    const prims = [
      poly({ wallId: "w1" }, square(0, 0, 1, 1)),
      poly({ ceilingId: "c1" }, square(1, 1, 2, 2)),
      poly({ roomId: "r1" }, square(2, 2, 3, 3)),
      poly({ stairId: "s1" }, square(3, 3, 4, 4)),
    ];
    const rect = { minX: 0, minY: 0, maxX: 5, maxY: 5 };
    expect(marqueeHit(prims, rect, false)).toEqual(["w1"]);
    expect(marqueeHitCeilings(prims, rect, false)).toEqual(["c1"]);
    expect(marqueeHitRooms(prims, rect, false)).toEqual(["r1"]);
    expect(marqueeHitStairs(prims, rect, false)).toEqual(["s1"]);
  });
});
