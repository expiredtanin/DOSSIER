/**
 * Z-Anordnen von Zeichnungsebenen (`reorderDrawingLevels` in
 * `src/state/projectSlice.ts`) — dieselbe „front"/„back"/„forward"/„backward"-
 * Semantik wie `reorderDrawings`, nur für `project.drawingLevels` statt
 * `drawings2d`. Die Array-Reihenfolge bestimmt die Überlagerungs-Reihenfolge
 * bei mehreren gleichzeitig sichtbaren Ebenen (Nutzer-Wunsch: "Ansichten in
 * den Hintergrund legen können").
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import type { DrawingLevel } from "../model/types";

function floor(id: string): DrawingLevel {
  return {
    id,
    name: id,
    kind: "floor",
    visible: true,
    locked: false,
    floorHeight: 2.6,
    cutHeight: 1.0,
    baseElevation: 0,
  };
}

beforeEach(() => {
  setState({
    project: {
      ...sampleProject,
      drawingLevels: [floor("A"), floor("B"), floor("C"), floor("D")],
    },
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
});

function ids(): string[] {
  return getState().project.drawingLevels.map((l) => l.id);
}

describe("reorderDrawingLevels", () => {
  it("front: schiebt die Auswahl ans Ende, Reihenfolge untereinander bleibt", () => {
    getState().reorderDrawingLevels(["B", "A"], "front");
    expect(ids()).toEqual(["C", "D", "A", "B"]);
  });

  it("back: schiebt die Auswahl an den Anfang", () => {
    getState().reorderDrawingLevels(["C"], "back");
    expect(ids()).toEqual(["C", "A", "B", "D"]);
  });

  it("forward: contiguous block überholt genau einen Nachbarn", () => {
    getState().reorderDrawingLevels(["B", "C"], "forward");
    expect(ids()).toEqual(["A", "D", "B", "C"]);
  });

  it("backward: contiguous block überholt genau einen Nachbarn rückwärts", () => {
    getState().reorderDrawingLevels(["B", "C"], "backward");
    expect(ids()).toEqual(["B", "C", "A", "D"]);
  });

  it("unbekannte IDs werden ignoriert", () => {
    getState().reorderDrawingLevels(["nope"], "front");
    expect(ids()).toEqual(["A", "B", "C", "D"]);
  });

  it("ist ein normaler Undo-Schritt", () => {
    getState().reorderDrawingLevels(["A"], "front");
    expect(ids()).toEqual(["B", "C", "D", "A"]);
    expect(getState().canUndo).toBe(true);
    getState().undo();
    expect(ids()).toEqual(["A", "B", "C", "D"]);
  });
});
