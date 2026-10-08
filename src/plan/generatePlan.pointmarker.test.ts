/**
 * `generatePlan` — Rendering des Punkt-/Knotenmarkers (`shape:"pointmarker"`):
 * Kreuz-in-Kreis, fixe Modell-Meter-Grösse (s. `drawing2d.ts`).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Drawing2D, Project } from "../model/types";

function pointMarkerDrawing(id: string, at = { x: 2, y: 1 }): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "pointmarker", at },
  };
}

function project(drawings: Drawing2D[]): Project {
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
    drawings2d: drawings,
    context: [],
  } as unknown as Project;
}

const visible = new Set(["20"]);

describe("generatePlan — Drawing2D pointmarker", () => {
  it("erzeugt einen Kreis + zwei Kreuz-Linien", () => {
    const p = project([pointMarkerDrawing("d1")]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const circles = plan.primitives.filter((pr) => pr.kind === "drawingCircle" && pr.drawingId === "d1");
    const lines = plan.primitives.filter((pr) => pr.kind === "line" && pr.drawingId === "d1");
    expect(circles.length).toBe(1);
    expect(lines.length).toBe(2); // waagrecht + senkrecht
  });

  it("Kreis-Zentrum und Kreuz-Mittelpunkt entsprechen 'at'", () => {
    const p = project([pointMarkerDrawing("d1", { x: 5, y: 3 })]);
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const circle = plan.primitives.find((pr) => pr.kind === "drawingCircle" && pr.drawingId === "d1");
    expect(circle && circle.kind === "drawingCircle" && circle.center).toEqual({ x: 5, y: 3 });
    const lines = plan.primitives.filter(
      (pr): pr is Extract<typeof pr, { kind: "line" }> => pr.kind === "line" && pr.drawingId === "d1",
    );
    const horizontal = lines.find((l) => l.a.y === l.b.y);
    const vertical = lines.find((l) => l.a.x === l.b.x);
    expect(horizontal).toBeDefined();
    expect(vertical).toBeDefined();
    expect((horizontal!.a.x + horizontal!.b.x) / 2).toBeCloseTo(5, 6);
    expect((vertical!.a.y + vertical!.b.y) / 2).toBeCloseTo(3, 6);
  });
});
