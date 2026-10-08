/**
 * Objekt-Sperre (`Wall.locked`/`Drawing2D.locked`) blockiert die MODIFIKATION
 * direkt an den Mutations-Stellen (`moveGrip`/`moveElementBy`/`moveEdge` in
 * projectSlice.ts) — bewusst NICHT die Auswahl selbst (sonst keine Möglichkeit
 * mehr, ein gesperrtes Element über das Kontextmenü wieder zu entsperren,
 * sobald die Selektion einmal woanders hin wechselt). S. auch
 * `tools/transform.test.ts` für dieselbe Prüfung bei move/copy/mirror/…
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Wall } from "../model/types";

const lockedWall: Wall = {
  id: "w-locked",
  type: "wall",
  floorId: "eg",
  categoryCode: "20",
  start: { x: 0, y: 0 },
  end: { x: 4, y: 0 },
  wallTypeId: sampleProject.wallTypes[0]?.id ?? "wt1",
  height: 2.6,
  locked: true,
};

const lockedDrawing: Drawing2D = {
  id: "d-locked",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 2, y: 0 } },
  locked: true,
};

beforeEach(() => {
  setState({
    project: { ...sampleProject, walls: [lockedWall], drawings2d: [lockedDrawing] },
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
});

describe("moveGripOf — Objekt-Sperre", () => {
  it("gesperrte Wand: Griff-Ziehen ist ein No-Op", () => {
    getState().moveGripOf(null, "w-locked", 0, { x: 9, y: 9 });
    const w = getState().project.walls.find((x) => x.id === "w-locked")!;
    expect(w.start).toEqual({ x: 0, y: 0 });
  });

  it("gesperrte 2D-Zeichnung: Griff-Ziehen ist ein No-Op", () => {
    getState().moveGripOf("d-locked", null, 0, { x: 9, y: 9 });
    const g = getState().project.drawings2d.find((x) => x.id === "d-locked")!.geom;
    expect(g.shape).toBe("line");
    if (g.shape === "line") expect(g.a).toEqual({ x: 0, y: 0 });
  });
});

describe("moveElementByOf — Objekt-Sperre", () => {
  it("gesperrte Wand: Körper-Verschieben ist ein No-Op", () => {
    getState().moveElementByOf(null, "w-locked", { x: 3, y: 3 });
    const w = getState().project.walls.find((x) => x.id === "w-locked")!;
    expect(w.start).toEqual({ x: 0, y: 0 });
    expect(w.end).toEqual({ x: 4, y: 0 });
  });

  it("gesperrte 2D-Zeichnung: Körper-Verschieben ist ein No-Op", () => {
    getState().moveElementByOf("d-locked", null, { x: 3, y: 3 });
    const g = getState().project.drawings2d.find((x) => x.id === "d-locked")!.geom;
    expect(g.shape).toBe("line");
    if (g.shape === "line") expect(g.a).toEqual({ x: 0, y: 0 });
  });
});

describe("moveEdgeOf — Objekt-Sperre", () => {
  it("gesperrte 2D-Zeichnung: Kanten-Ziehen ist ein No-Op", () => {
    getState().moveEdgeOf("d-locked", null, 0, 1, { x: 3, y: 3 });
    const g = getState().project.drawings2d.find((x) => x.id === "d-locked")!.geom;
    expect(g.shape).toBe("line");
    if (g.shape === "line") {
      expect(g.a).toEqual({ x: 0, y: 0 });
      expect(g.b).toEqual({ x: 2, y: 0 });
    }
  });
});
