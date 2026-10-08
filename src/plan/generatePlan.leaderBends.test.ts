// `Drawing2DGeom["text"].leaderBendPoints` — Rendering mehrsegmentiger
// Hinweislinien (Nutzer-Wunsch: „kein Knick-Punkt wie bei AutoCADs
// Multileader"). Ohne Knickpunkte MUSS das Ergebnis identisch zum bisherigen
// Einzelsegment-Verhalten bleiben (reine Additiv-Erweiterung).

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Drawing2D, Project } from "../model/types";

function leaderDrawing(bendPoints?: { x: number; y: number }[]): Drawing2D {
  return {
    id: "L1",
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: {
      shape: "text",
      at: { x: 0, y: 0 },
      text: "",
      height: 0.2,
      angle: 0,
      leaderTarget: { x: 10, y: 0 },
      ...(bendPoints ? { leaderBendPoints: bendPoints } : {}),
    },
  };
}

function project(drawing: Drawing2D): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [drawing],
    context: [],
  } as unknown as Project;
}

const visible = new Set(["20"]);

function leaderLineSegments(drawing: Drawing2D) {
  return generatePlan(project(drawing), "eg", visible)
    .primitives.filter(
      (p): p is Extract<typeof p, { kind: "line" }> => p.kind === "line" && p.drawingId === "L1",
    );
}

describe("generatePlan — leaderBendPoints (Multileader)", () => {
  it("ohne Knickpunkte: GENAU EIN Segment (unverändertes Verhalten)", () => {
    const segs = leaderLineSegments(leaderDrawing());
    expect(segs).toHaveLength(1);
    expect(segs[0].a).toEqual({ x: 0, y: 0 }); // Textanker
    // b ist die Spitze, zurückgezogen um die Pfeillänge — nicht exakt (10,0).
    expect(segs[0].b.x).toBeLessThan(10);
    expect(segs[0].b.y).toBeCloseTo(0, 9);
  });

  it("ein Knickpunkt: ZWEI Segmente (Anker→Knick, Knick→Spitze)", () => {
    const segs = leaderLineSegments(leaderDrawing([{ x: 5, y: 5 }]));
    expect(segs).toHaveLength(2);
    // Erstes Segment: Anker → Knick (voller Punkt, kein Pfeil-Rückzug).
    expect(segs[0].a).toEqual({ x: 0, y: 0 });
    expect(segs[0].b).toEqual({ x: 5, y: 5 });
    // Zweites Segment: Knick → Spitze (zurückgezogen).
    expect(segs[1].a).toEqual({ x: 5, y: 5 });
    expect(segs[1].b.x).toBeLessThan(10);
  });

  it("zwei Knickpunkte: DREI Segmente in Klick-Reihenfolge", () => {
    const segs = leaderLineSegments(leaderDrawing([{ x: 3, y: 3 }, { x: 6, y: -2 }]));
    expect(segs).toHaveLength(3);
    expect(segs[0].a).toEqual({ x: 0, y: 0 });
    expect(segs[0].b).toEqual({ x: 3, y: 3 });
    expect(segs[1].a).toEqual({ x: 3, y: 3 });
    expect(segs[1].b).toEqual({ x: 6, y: -2 });
    expect(segs[2].a).toEqual({ x: 6, y: -2 });
  });

  it("die Pfeilspitze richtet sich nach dem LETZTEN Segment, nicht der vollen Anker→Spitze-Richtung", () => {
    // Knick direkt ÜBER der Spitze (9,5) → letztes Segment zeigt fast senkrecht
    // nach unten zur Spitze (10,0), ganz anders als die direkte Gesamtrichtung
    // Anker(0,0)→Spitze(10,0) (waagrecht).
    const segs = leaderLineSegments(leaderDrawing([{ x: 9, y: 5 }]));
    const last = segs[segs.length - 1];
    // b liegt nahe (10,0), zurückgezogen ENTLANG der Knick→Spitze-Richtung
    // (steil, fast senkrecht) — NICHT entlang der waagrechten Gesamtrichtung.
    expect(Math.abs(last.b.x - 10)).toBeLessThan(0.3);
    expect(last.b.y).toBeGreaterThan(0); // noch auf dem Weg von (9,5) nach (10,0), nicht bei y=0
  });
});
