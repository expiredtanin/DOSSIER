// Kanten und Höfe eines Dachs ([26]): Änderung der Kantenneigung, Hof hinzufügen/entfernen (die
// Kantenliste rechnet der Kern, Test in `state/selectionInfo.test.ts`).
import { describe, expect, it } from "vitest";
import type { Roof, Vec2 } from "../model/types";
import { removeRoofHole, setRoofEdge } from "./roofEdges";

const rect = (x: number, y: number, w: number, h: number): Vec2[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

const roof = (extra: Partial<Roof> = {}): Roof => ({
  id: "R",
  type: "roof",
  floorId: "eg",
  categoryCode: "31",
  outline: rect(0, 0, 12, 8),
  shape: "walm",
  pitchDeg: 35,
  overhang: 0,
  ridgeAxis: "x",
  thickness: 0.2,
  ...extra,
});

const court = rect(4, 2, 4, 4);

describe("setRoofEdge", () => {
  it("setzt Neigung/Giebel, füllt mit Standard auf, entfernt das Feld wenn alles Standard", () => {
    const a = setRoofEdge(roof(), 2, { kind: "pitch", deg: 25 });
    expect(a.edgePitchDeg).toEqual([-1, -1, 25]);
    const b = setRoofEdge(roof({ ...a }), 0, { kind: "gable" });
    expect(b.edgePitchDeg).toEqual([null, -1, 25]);
    const c = setRoofEdge(roof({ ...b }), 0, { kind: "default" });
    const d = setRoofEdge(roof({ ...c }), 2, { kind: "default" });
    expect(d.edgePitchDeg).toBeUndefined();
  });

  it("begrenzt die Neigung auf 0..89 Grad", () => {
    expect(setRoofEdge(roof(), 0, { kind: "pitch", deg: 120 }).edgePitchDeg).toEqual([89]);
    expect(setRoofEdge(roof(), 0, { kind: "pitch", deg: -5 }).edgePitchDeg).toEqual([0]);
  });
});

describe("Höfe", () => {

  it("Hof entfernen nimmt seine Kantenneigungen mit; Indizes der übrigen Höfe rücken nach", () => {
    const h2 = rect(1, 1, 1, 1);
    const r = roof({ holes: [court, h2], edgePitchDeg: [-1, -1, -1, -1, 10, -1, -1, -1, 50, -1, -1, -1] });
    const p = removeRoofHole(r, 0);
    expect(p.holes).toEqual([h2]);
    expect(p.edgePitchDeg).toEqual([-1, -1, -1, -1, 50]);
    const q = removeRoofHole(roof({ ...p }), 0);
    expect(q.holes).toBeUndefined();
    expect(q.edgePitchDeg).toBeUndefined();
  });

  it("Hof entfernen ohne Kantenfeld lässt es weg", () => {
    const p = removeRoofHole(roof({ holes: [court] }), 0);
    expect(p).toEqual({ holes: undefined, edgePitchDeg: undefined });
  });
});
