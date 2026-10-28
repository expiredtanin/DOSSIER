// Dach-3D-Griffe: Store-Mutationen moveRoofGrip (Eckpunkt-Resize, gegenüber-
// liegende Ecke bleibt fix) und moveRoofBy (Verschieben des ganzen Umrisses).
// Beide werden bei jedem Maus-Move-Schritt aufgerufen und müssen zu EINEM
// Undo-Schritt koaleszieren (coalesceKey pro Dach).

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import type { Project, Roof } from "../model/types";

const roof: Roof = {
  id: "RF1",
  type: "roof",
  floorId: "eg",
  categoryCode: "31",
  outline: [
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    { x: 6, y: 4 },
    { x: 0, y: 4 },
  ],
  shape: "sattel",
  pitchDeg: 45,
  overhang: 0,
  ridgeAxis: "x",
  thickness: 0.2,
};

const baseProject = {
  id: "p",
  name: "T",
  layers: [],
  drawingLevels: [
    { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, baseElevation: 0 },
  ],
  walls: [],
  drawings2d: [],
  roofs: [roof],
} as unknown as Project;

beforeEach(() => {
  setState({
    project: JSON.parse(JSON.stringify(baseProject)),
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
});

describe("moveRoofGrip — Eckpunkt-Resize", () => {
  it("zieht Ecke 0 und hält die gegenüberliegende Ecke (2) fix", () => {
    // Ecke 0 (0,0) auf (-1,-1) ziehen; Gegenecke 2 = (6,4) bleibt.
    getState().moveRoofGrip("RF1", 0, { x: -1, y: -1 });
    const r = getState().project.roofs![0];
    // Umriss neu als achsparallles Rechteck [minX,minY]..[maxX,maxY].
    expect(r.outline).toEqual([
      { x: -1, y: -1 },
      { x: 6, y: -1 },
      { x: 6, y: 4 },
      { x: -1, y: 4 },
    ]);
  });

  it("hochfrequente Drags koaleszieren zu EINEM Undo-Schritt", () => {
    // Saubere Koaleszenz-Grenze: eine diskrete (keyless) Aktion setzt den
    // Koaleszenz-Schlüssel im Kern zurück, danach Verlauf leeren.
    getState().updateRoof("RF1", { overhang: 0.1 });
    getState().clearHistory();
    getState().moveRoofGrip("RF1", 2, { x: 5, y: 3 });
    getState().moveRoofGrip("RF1", 2, { x: 5.5, y: 3.5 });
    getState().moveRoofGrip("RF1", 2, { x: 7, y: 5 });
    expect(getState().undoDepth).toBe(1);
    getState().undo();
    // Nach einem Undo wieder der Ausgangsumriss.
    expect(getState().project.roofs![0].outline).toEqual(baseProject.roofs![0].outline);
  });
});

describe("moveRoofBy — Verschieben", () => {
  it("verschiebt alle Eckpunkte um delta", () => {
    getState().moveRoofBy("RF1", { x: 2, y: -1 });
    const r = getState().project.roofs![0];
    expect(r.outline).toEqual([
      { x: 2, y: -1 },
      { x: 8, y: -1 },
      { x: 8, y: 3 },
      { x: 2, y: 3 },
    ]);
  });
});
