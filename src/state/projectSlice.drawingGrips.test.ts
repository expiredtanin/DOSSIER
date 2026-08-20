/**
 * Editier-Griffe für Kreis/Bogen-2D-Elemente (`drawingVertices`/`moveGripOf`
 * in `projectSlice.ts`). Vorher gab es dafür keine Griffe (leeres Array) —
 * Regressionsschutz für den Nachzieh-Fix (2D-Vervollständigung, Fund A).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { drawingVertices } from "./projectSlice";
import type { Drawing2D } from "../model/types";

const circleDrawing: Drawing2D = {
  id: "d-circle",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: { shape: "circle", center: { x: 2, y: 3 }, r: 1 },
};

const arcDrawing: Drawing2D = {
  id: "d-arc",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: { shape: "arc", center: { x: 0, y: 0 }, r: 2, a0: 0, a1: Math.PI / 2 },
};

beforeEach(() => {
  setState({
    project: {
      ...sampleProject,
      drawings2d: [circleDrawing, arcDrawing],
    },
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
});

describe("drawingVertices — Kreis/Bogen", () => {
  it("Kreis liefert einen Radius-Griff auf der Ost-Seite", () => {
    const v = drawingVertices(circleDrawing);
    expect(v).toEqual([{ x: 3, y: 3 }]);
  });

  it("Bogen liefert Start-/End-/Mittel-Winkel-Griffe", () => {
    const v = drawingVertices(arcDrawing);
    expect(v.length).toBe(3);
    expect(v[0]).toEqual({ x: 2, y: 0 }); // a0 = 0
    expect(v[1].x).toBeCloseTo(0, 9); // a1 = PI/2
    expect(v[1].y).toBeCloseTo(2, 9);
  });
});

describe("moveGripOf — Kreis/Bogen", () => {
  it("Kreis-Griff ziehen ändert nur den Radius, nicht das Zentrum", () => {
    getState().moveGripOf("d-circle", null, 0, { x: 5, y: 3 }); // 3m vom Zentrum
    const g = getState().project.drawings2d.find((d) => d.id === "d-circle")!.geom;
    expect(g).toMatchObject({ shape: "circle", center: { x: 2, y: 3 }, r: 3 });
  });

  it("Bogen-Start-Griff (Index 0) ändert a0, nicht r/a1", () => {
    getState().moveGripOf("d-arc", null, 0, { x: 0, y: 2 }); // 90° = PI/2
    const g = getState().project.drawings2d.find((d) => d.id === "d-arc")!.geom;
    expect(g.shape).toBe("arc");
    if (g.shape === "arc") {
      expect(g.a0).toBeCloseTo(Math.PI / 2, 9);
      expect(g.a1).toBeCloseTo(Math.PI / 2, 9); // unverändert
      expect(g.r).toBeCloseTo(2, 9); // unverändert
    }
  });

  it("Bogen-Radius-Griff (Index 2) ändert nur r, nicht a0/a1", () => {
    getState().moveGripOf("d-arc", null, 2, { x: 4, y: 0 }); // gleiche Richtung, doppelter Radius
    const g = getState().project.drawings2d.find((d) => d.id === "d-arc")!.geom;
    expect(g.shape).toBe("arc");
    if (g.shape === "arc") {
      expect(g.a0).toBeCloseTo(0, 9);
      expect(g.a1).toBeCloseTo(Math.PI / 2, 9);
      expect(g.r).toBeCloseTo(4, 9);
    }
  });
});
