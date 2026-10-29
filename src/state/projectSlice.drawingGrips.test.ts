/**
 * Editier-Griffe für Kreis/Bogen-2D-Elemente (`drawingVertices`/`moveGripOf`
 * in `projectSlice.ts`). Vorher gab es dafür keine Griffe (leeres Array) —
 * Regressionsschutz für den Nachzieh-Fix (2D-Vervollständigung, Fund A).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { drawingVertices } from "../core";
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
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
});

describe("drawingVertices — Kreis/Bogen", () => {
  it("Kreis liefert zwei Griffe (Ost/Nord) — wie eine Ellipse", () => {
    const v = drawingVertices(circleDrawing);
    expect(v).toEqual([{ x: 3, y: 3 }, { x: 2, y: 4 }]);
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
  it("Kreis-Ost-Griff auf denselben Radius gezogen bleibt ein Kreis", () => {
    getState().moveGripOf("d-circle", null, 0, { x: 3, y: 3 }); // weiterhin 1m Ost
    const g = getState().project.drawings2d.find((d) => d.id === "d-circle")!.geom;
    expect(g).toMatchObject({ shape: "circle", center: { x: 2, y: 3 }, r: 1 });
  });

  it("Kreis-Ost-Griff auf einen ANDEREN Radius gezogen wird zur Ellipse (Nutzer-Wunsch: Kreis kann beim Bearbeiten zur Ellipse werden)", () => {
    getState().moveGripOf("d-circle", null, 0, { x: 5, y: 3 }); // 3m Ost statt 1m
    const g = getState().project.drawings2d.find((d) => d.id === "d-circle")!.geom;
    expect(g).toMatchObject({ shape: "ellipse", center: { x: 2, y: 3 }, rx: 3, ry: 1, rotation: 0 });
  });

  it("Ellipse-Griff zurück auf (fast) gleiche Halbachsen gezogen wird wieder zum Kreis", () => {
    getState().moveGripOf("d-circle", null, 0, { x: 5, y: 3 }); // → Ellipse rx=3, ry=1
    getState().moveGripOf("d-circle", null, 1, { x: 2, y: 6 }); // Nord-Griff auf ry=3
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
