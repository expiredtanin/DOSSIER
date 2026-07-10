// Schnitt-Tiefe (DrawingLevel.depth): filterByDepth blendet Ansichtskanten aus,
// deren Quell-Wand weiter als `depth` hinter der Schnittebene (Blickrichtung)
// liegt. Owner-Distanz-Näherung (Wand-Mitte) — reiner TS-Datenpfad, ohne WASM.

import { describe, it, expect } from "vitest";
import { filterByDepth } from "./toSection";
import type { SectionOutput, SectionPlaneSpec } from "./toSection";
import type { Project, Wall } from "../model/types";

// Zwei Wände auf verschiedenen Tiefen: W_near bei y=1, W_far bei y=8.
function makeWall(id: string, y: number): Wall {
  return {
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    wallTypeId: "wt",
    start: { x: 0, y },
    end: { x: 4, y },
    height: 2.6,
  } as unknown as Wall;
}

const project = {
  id: "p",
  name: "T",
  walls: [makeWall("W_near", 1), makeWall("W_far", 8)],
  ceilings: [],
  roofs: [],
  openings: [],
  doors: [],
  components: [],
  wallTypes: [],
  drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false }],
} as unknown as Project;

// Schnittebene bei y=0, Blickrichtung +y (in die Szene). wallSegmentOwners
// nummeriert die Wände in project.walls-Reihenfolge: index 0 = W_near, 1 = W_far.
const plane: SectionPlaneSpec = { point: [0, 0, 0], normal: [0, 0, 1] };

function edge(index: number) {
  return { component: { kind: "wall" as const, index }, a: [0, 0] as [number, number], b: [1, 1] as [number, number] };
}

describe("filterByDepth", () => {
  it("behält nahe Kanten, verwirft Kanten hinter der Tiefengrenze", () => {
    const out: SectionOutput = {
      cutPolygons: [],
      visibleEdges: [edge(0), edge(1)],
      hiddenEdges: [edge(1)],
    };
    filterByDepth(out, project, plane, 4); // Tiefe 4 m: W_near (1) bleibt, W_far (8) fällt weg.
    expect(out.visibleEdges.map((e) => e.component.index)).toEqual([0]);
    expect(out.hiddenEdges).toHaveLength(0);
  });

  it("behält alles, wenn die Tiefe alle Bauteile umfasst", () => {
    const out: SectionOutput = {
      cutPolygons: [],
      visibleEdges: [edge(0), edge(1)],
      hiddenEdges: [],
    };
    filterByDepth(out, project, plane, 20);
    expect(out.visibleEdges).toHaveLength(2);
  });

  it("depth <= 0 ist ein No-op", () => {
    const out: SectionOutput = { cutPolygons: [], visibleEdges: [edge(0), edge(1)], hiddenEdges: [] };
    filterByDepth(out, project, plane, 0);
    expect(out.visibleEdges).toHaveLength(2);
  });
});
