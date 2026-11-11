// [26] Dach-Griffe im Grundriss: Ecke und Kante von Umriss bzw. Hof über die Store-Aktionen
// (flacher Index: erst `outline`, dann `holes`). Der Umriss bleibt frei (kein Rechteck), ein Zug = ein Undo-Schritt.
import { beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "./appStore";
import type { Project, Roof } from "../model/types";

const roof: Roof = {
  id: "RF1",
  type: "roof",
  floorId: "eg",
  categoryCode: "31",
  outline: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 12, y: 8 },
    { x: 0, y: 8 },
  ],
  holes: [
    [
      { x: 3, y: 2 },
      { x: 5, y: 2 },
      { x: 5, y: 4 },
      { x: 3, y: 4 },
    ],
  ],
  shape: "walm",
  pitchDeg: 35,
  overhang: 0,
  ridgeAxis: "x",
  thickness: 0.2,
};

const baseProject = {
  id: "p",
  name: "T",
  layers: [],
  drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, baseElevation: 0 }],
  walls: [],
  drawings2d: [],
  roofs: [roof],
} as unknown as Project;

const current = (): Roof => getState().project.roofs![0];

beforeEach(() => {
  setState({ project: JSON.parse(JSON.stringify(baseProject)), undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
  getState().clearHistory();
});

describe("Dach-Griffe im Grundriss", () => {
  it("Umriss-Ecke ziehen: nur diese Ecke wandert, ein Undo-Schritt", () => {
    getState().moveRoofVertex("RF1", 2, { x: 13, y: 9 });
    expect(current().outline[2]).toEqual({ x: 13, y: 9 });
    expect(current().outline[1]).toEqual({ x: 10, y: 0 });
    expect(current().holes).toEqual(roof.holes);
    expect(getState().undoDepth).toBe(1);
    getState().undo();
    expect(current().outline).toEqual(roof.outline);
  });

  it("Hof-Ecke und Hof-Kante über den flachen Index", () => {
    getState().moveRoofVertex("RF1", 6, { x: 6, y: 5 });
    expect(current().holes![0][2]).toEqual({ x: 6, y: 5 });
    getState().moveRoofEdge("RF1", 4, 5, { x: 0, y: -1 });
    expect(current().holes![0][0].y).toBe(1);
    expect(current().holes![0][1].y).toBe(1);
    expect(current().outline).toEqual(roof.outline);
  });

  it("Kante über zwei Ringe oder ausserhalb: keine Änderung", () => {
    getState().moveRoofEdge("RF1", 3, 4, { x: 0, y: 1 });
    getState().moveRoofVertex("RF1", 99, { x: 0, y: 0 });
    expect(current()).toEqual(roof);
    expect(getState().undoDepth).toBe(0);
  });
});
