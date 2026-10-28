/**
 * Z-Anordnen von 2D-Zeichnungselementen (`reorderDrawings` in
 * `src/state/projectSlice.ts`). Die Array-Reihenfolge in `drawings2d` IST die
 * Zeichenreihenfolge im Grundriss (spätere Position = weiter oben, siehe
 * `generatePlan.ts`) — „front"/„back"/„forward"/„backward" sortieren das
 * Array um.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D } from "../model/types";

function rect(id: string): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "A",
    geom: { shape: "rect", min: { x: 0, y: 0 }, max: { x: 1, y: 1 } },
  };
}

beforeEach(() => {
  setState({
    project: {
      ...sampleProject,
      drawings2d: [rect("A"), rect("B"), rect("C"), rect("D")],
    },
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
});

function ids(): string[] {
  return getState().project.drawings2d.map((d) => d.id);
}

describe("reorderDrawings", () => {
  it("front: schiebt die Auswahl ans Ende, Reihenfolge untereinander bleibt", () => {
    getState().reorderDrawings(["B", "A"], "front");
    // Auswahl-Reihenfolge im Array bleibt A vor B (Array-Reihenfolge zählt,
    // nicht die Aufruf-Reihenfolge der ids).
    expect(ids()).toEqual(["C", "D", "A", "B"]);
  });

  it("back: schiebt die Auswahl an den Anfang", () => {
    getState().reorderDrawings(["C"], "back");
    expect(ids()).toEqual(["C", "A", "B", "D"]);
  });

  it("forward: contiguous block überholt genau einen Nachbarn", () => {
    getState().reorderDrawings(["B", "C"], "forward");
    expect(ids()).toEqual(["A", "D", "B", "C"]);
  });

  it("backward: contiguous block überholt genau einen Nachbarn rückwärts", () => {
    getState().reorderDrawings(["B", "C"], "backward");
    expect(ids()).toEqual(["B", "C", "A", "D"]);
  });

  it("forward: letztes Element bleibt am Ende (kein Überlauf)", () => {
    getState().reorderDrawings(["D"], "forward");
    expect(ids()).toEqual(["A", "B", "C", "D"]);
  });

  it("backward: erstes Element bleibt am Anfang (kein Überlauf)", () => {
    getState().reorderDrawings(["A"], "backward");
    expect(ids()).toEqual(["A", "B", "C", "D"]);
  });

  it("unbekannte IDs werden ignoriert", () => {
    getState().reorderDrawings(["nope"], "front");
    expect(ids()).toEqual(["A", "B", "C", "D"]);
  });

  it("ist ein normaler Undo-Schritt", () => {
    getState().reorderDrawings(["A"], "front");
    expect(ids()).toEqual(["B", "C", "D", "A"]);
    expect(getState().canUndo).toBe(true);
    getState().undo();
    expect(ids()).toEqual(["A", "B", "C", "D"]);
  });
});
