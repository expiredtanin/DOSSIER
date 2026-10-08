/**
 * Griffe einer mehrsegmentigen Hinweislinie (`leaderBendPoints`) —
 * `drawingVertices`/`moveGripOf` in `projectSlice.ts`. Reihenfolge: Anker
 * (Index 0) → Knickpunkte (Index 1..N) → Spitze (letzter Index), wie der
 * Pfad gerendert wird (s. `plan/generatePlan.leaderBends.test.ts`).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { drawingVertices } from "./projectSlice";
import type { Drawing2D } from "../model/types";

const leaderNoBends: Drawing2D = {
  id: "d-leader-0",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: { shape: "text", at: { x: 0, y: 0 }, text: "", height: 0.2, angle: 0, leaderTarget: { x: 10, y: 0 } },
};

const leaderTwoBends: Drawing2D = {
  id: "d-leader-2",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: {
    shape: "text",
    at: { x: 0, y: 0 },
    text: "",
    height: 0.2,
    angle: 0,
    leaderTarget: { x: 10, y: 0 },
    leaderBendPoints: [{ x: 3, y: 3 }, { x: 6, y: -2 }],
  },
};

beforeEach(() => {
  setState({
    project: { ...sampleProject, drawings2d: [leaderNoBends, leaderTwoBends] },
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
});

describe("drawingVertices — Hinweislinie mit Knickpunkten", () => {
  it("ohne Knicke: weiterhin genau zwei Griffe (Anker, Spitze)", () => {
    expect(drawingVertices(leaderNoBends)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });

  it("zwei Knicke: vier Griffe in Reihenfolge Anker→Knick1→Knick2→Spitze", () => {
    expect(drawingVertices(leaderTwoBends)).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 3 },
      { x: 6, y: -2 },
      { x: 10, y: 0 },
    ]);
  });
});

describe("moveGripOf — Hinweislinie mit Knickpunkten", () => {
  it("Griff 0 verschiebt den Textanker (`at`), Knicke/Spitze bleiben unverändert", () => {
    getState().moveGripOf("d-leader-2", null, 0, { x: -5, y: -5 });
    const g = getState().project.drawings2d.find((d) => d.id === "d-leader-2")!.geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.at).toEqual({ x: -5, y: -5 });
      expect(g.leaderBendPoints).toEqual([{ x: 3, y: 3 }, { x: 6, y: -2 }]);
      expect(g.leaderTarget).toEqual({ x: 10, y: 0 });
    }
  });

  it("Griff 1 verschiebt NUR den ersten Knickpunkt", () => {
    getState().moveGripOf("d-leader-2", null, 1, { x: 1, y: 9 });
    const g = getState().project.drawings2d.find((d) => d.id === "d-leader-2")!.geom;
    if (g.shape === "text") {
      expect(g.leaderBendPoints).toEqual([{ x: 1, y: 9 }, { x: 6, y: -2 }]);
      expect(g.at).toEqual({ x: 0, y: 0 });
      expect(g.leaderTarget).toEqual({ x: 10, y: 0 });
    }
  });

  it("Griff 2 verschiebt NUR den zweiten Knickpunkt", () => {
    getState().moveGripOf("d-leader-2", null, 2, { x: 7, y: 7 });
    const g = getState().project.drawings2d.find((d) => d.id === "d-leader-2")!.geom;
    if (g.shape === "text") {
      expect(g.leaderBendPoints).toEqual([{ x: 3, y: 3 }, { x: 7, y: 7 }]);
    }
  });

  it("letzter Griff (Index 3) verschiebt die Spitze (`leaderTarget`), Knicke bleiben", () => {
    getState().moveGripOf("d-leader-2", null, 3, { x: 20, y: 20 });
    const g = getState().project.drawings2d.find((d) => d.id === "d-leader-2")!.geom;
    if (g.shape === "text") {
      expect(g.leaderTarget).toEqual({ x: 20, y: 20 });
      expect(g.leaderBendPoints).toEqual([{ x: 3, y: 3 }, { x: 6, y: -2 }]);
    }
  });
});
