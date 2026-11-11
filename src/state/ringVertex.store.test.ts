// [26] Ecke einfügen/löschen an Umriss-Ringen (Dach samt Hof, Decke, geschlossene Polylinie) über den Store:
// ein Undo-Schritt je Aktion, Einfügen + Zug + Aufräumen mit gleichem Schlüssel ebenso; Kanten-Neigung des Dachs läuft mit.
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
    { x: 12, y: 0 },
    { x: 12, y: 8 },
    { x: 0, y: 8 },
  ],
  holes: [
    [
      { x: 4, y: 2 },
      { x: 4, y: 6 },
      { x: 8, y: 6 },
    ],
  ],
  edgePitchDeg: [30, null, 40, 50, 20, 21, 22],
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
  drawings2d: [
    {
      id: "pl",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "polyline", closed: true, pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }] },
    },
  ],
  roofs: [roof],
} as unknown as Project;

const current = (): Roof => getState().project.roofs![0];
const poly = () => {
  const g = getState().project.drawings2d.find((d) => d.id === "pl")!.geom;
  if (g.shape !== "polyline") throw new Error("keine Polylinie");
  return g;
};

beforeEach(() => {
  setState({ project: JSON.parse(JSON.stringify(baseProject)), undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
  getState().clearHistory();
});

describe("Ecken am Dach", () => {
  it("Einfügen erbt die geteilte Kante, ein Undo-Schritt", () => {
    getState().insertRingVertex("roof", "RF1", 1, { x: 13, y: 4 });
    expect(current().outline).toHaveLength(5);
    expect(current().outline[2]).toEqual({ x: 13, y: 4 });
    expect(current().edgePitchDeg).toEqual([30, null, null, 40, 50, 20, 21, 22]);
    expect(getState().undoDepth).toBe(1);
    getState().undo();
    expect(current().outline).toHaveLength(4);
    expect(current().edgePitchDeg).toEqual([30, null, 40, 50, 20, 21, 22]);
  });

  it("Einfügen, Ziehen und Aufräumen mit gleichem Schlüssel sind ein Schritt; auf die Gerade zurück entfällt die Ecke", () => {
    const key = "ringInsert:RF1:1";
    getState().insertRingVertex("roof", "RF1", 0, { x: 6, y: 1 }, key);
    getState().moveRingVertex("roof", "RF1", 1, { x: 6, y: 3 }, key);
    getState().moveRingVertex("roof", "RF1", 1, { x: 6, y: 0.001 }, key);
    getState().tidyRingVertex("roof", "RF1", 1, key, 0.01);
    expect(current().outline).toHaveLength(4);
    expect(current().edgePitchDeg).toEqual([30, null, 40, 50, 20, 21, 22]);
    getState().undo();
    expect(current().outline).toHaveLength(4);
    expect(getState().canUndo).toBe(false);
  });

  it("gezogene Ecke bleibt, solange sie nicht auf der Geraden liegt (ein Undo-Schritt)", () => {
    const key = "ringInsert:RF1:2";
    getState().insertRingVertex("roof", "RF1", 0, { x: 6, y: 1 }, key);
    getState().moveRingVertex("roof", "RF1", 1, { x: 6, y: -2 }, key);
    getState().tidyRingVertex("roof", "RF1", 1, key, 0.01);
    expect(current().outline).toHaveLength(5);
    expect(current().outline[1]).toEqual({ x: 6, y: -2 });
    expect(getState().undoDepth).toBe(1);
  });

  it("Löschen: Hof-Ecke geht nicht unter drei, Umriss-Ecke schon, Kanten-Eintrag entfällt", () => {
    getState().deleteRingVertex("roof", "RF1", 4); // Hof hat 3 Ecken
    expect(current().holes![0]).toHaveLength(3);
    expect(getState().canUndo).toBe(false);
    getState().deleteRingVertex("roof", "RF1", 2);
    expect(current().outline).toHaveLength(3);
    expect(current().edgePitchDeg).toEqual([30, null, 50, 20, 21, 22]);
    expect(getState().undoDepth).toBe(1);
  });
});

describe("Ecken an der geschlossenen Polylinie", () => {
  it("Einfügen, Aufräumen auf der Geraden, Löschen", () => {
    const key = "ringInsert:pl:1";
    getState().insertRingVertex("polyline", "pl", 0, { x: 2, y: 1 }, key);
    expect(poly().pts).toHaveLength(5);
    getState().moveRingVertex("polyline", "pl", 1, { x: 2, y: 0.002 }, key);
    getState().tidyRingVertex("polyline", "pl", 1, key, 0.01);
    expect(poly().pts).toHaveLength(4);
    expect(getState().undoDepth).toBe(1);

    getState().deleteRingVertex("polyline", "pl", 2);
    expect(poly().pts).toHaveLength(3);
    // Mindestens drei Ecken bleiben.
    getState().deleteRingVertex("polyline", "pl", 0);
    expect(poly().pts).toHaveLength(3);
  });
});
