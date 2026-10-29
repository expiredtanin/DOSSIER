// Dach: Kantenneigung und Innenhöfe ([26]) über Store/Ops — ein Undo-Schritt je Aktion — und die
// Rundreise durch das Projektformat (Rust-Modell ↔ TS: `holes`, `edgePitchDeg` mit `null` = Giebel).
import { beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "./appStore";
import type { Project, Roof } from "../model/types";
import { removeRoofHole, roofGeometry, setRoofEdge } from "../core";
import { parseProjectFile, serializeProject } from "../io/projectFormat";
import { sampleProject } from "../model/sampleProject";

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
  shape: "walm",
  pitchDeg: 35,
  overhang: 0,
  ridgeAxis: "x",
  thickness: 0.2,
};
const court = [
  { x: 4, y: 2 },
  { x: 4, y: 6 },
  { x: 8, y: 6 },
  { x: 8, y: 2 },
];

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

describe("Kantenneigung über Ops", () => {
  it("Kante ändern ist ein Undo-Schritt; Zurück stellt das Feld wieder her", () => {
    getState().updateRoof("RF1", setRoofEdge(current(), 0, { kind: "pitch", deg: 20 }));
    expect(current().edgePitchDeg).toEqual([20]);
    expect(getState().undoDepth).toBe(1);
    getState().undo();
    expect(current().edgePitchDeg).toBeUndefined();
  });

  it("Tippen einer Zahl (gleicher Schlüssel) koalesziert zu einem Schritt", () => {
    const key = "roof-edge-RF1-1";
    getState().updateRoof("RF1", { overhang: 0.1 }); // Koaleszenz-Grenze
    getState().clearHistory();
    getState().updateRoof("RF1", setRoofEdge(current(), 1, { kind: "pitch", deg: 3 }), key);
    getState().updateRoof("RF1", setRoofEdge(current(), 1, { kind: "pitch", deg: 30 }), key);
    expect(current().edgePitchDeg).toEqual([-1, 30]);
    expect(getState().undoDepth).toBe(1);
    getState().undo();
    expect(current().edgePitchDeg).toBeUndefined();
  });

  it("Giebel (null) bleibt im Projekt und ändert die Geometrie", () => {
    const before = roofGeometry(current(), 0);
    getState().updateRoof("RF1", { edgePitchDeg: [-1, null, -1, null] });
    expect(current().edgePitchDeg).toEqual([-1, null, -1, null]);
    const after = roofGeometry(current(), 0);
    expect(after.gables.length).toBe(2);
    expect(before.gables.length).toBe(0);
  });
});

describe("Innenhöfe über Ops", () => {
  it("Hof hinzufügen und entfernen: je ein Undo-Schritt, Dach spart den Hof aus", () => {
    getState().updateRoof("RF1", { holes: [...(current().holes ?? []), court] });
    expect(current().holes).toEqual([court]);
    expect(roofGeometry(current(), 0).eavesHoles).toHaveLength(1);
    expect(getState().undoDepth).toBe(1);
    getState().updateRoof("RF1", removeRoofHole(current(), 0));
    expect(current().holes).toBeUndefined();
    expect(getState().undoDepth).toBe(2);
    getState().undo();
    expect(current().holes).toEqual([court]);
    getState().undo();
    expect(current().holes).toBeUndefined();
  });
});

describe("Projektdatei: Rundreise", () => {
  it("holes und edgePitchDeg (mit null) überstehen Schreiben und Lesen", () => {
    const withFields: Roof = { ...roof, holes: [court], edgePitchDeg: [20, null, -1, 45, 10, -1, -1, null] };
    const p = { ...sampleProject, roofs: [withFields] } as Project;
    const r = parseProjectFile(serializeProject(p));
    if (!r.ok) throw new Error(r.error);
    expect(r.project.roofs![0].holes).toEqual([court]);
    expect(r.project.roofs![0].edgePitchDeg).toEqual([20, null, -1, 45, 10, -1, -1, null]);
  });

  it("ohne die Felder bleiben sie auch nach der Rundreise weg", () => {
    const p = { ...sampleProject, roofs: [roof] } as Project;
    const text = serializeProject(p);
    expect(text).not.toContain("edgePitchDeg");
    expect(text).not.toContain("holes");
    const r = parseProjectFile(text);
    if (!r.ok) throw new Error(r.error);
    expect("holes" in r.project.roofs![0]).toBe(false);
    expect("edgePitchDeg" in r.project.roofs![0]).toBe(false);
  });
});
