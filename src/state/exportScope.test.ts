// Export-Scope „nur Auswahl" (`filterProjectToSelection`/`selectionMemberCount`),
// s. exportScope.ts.

import { describe, it, expect } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { filterProjectToSelection, selectionMemberCount } from "./exportScope";
import type { Project, Wall, Drawing2D } from "../model/types";

const wall1: Wall = {
  id: "w1",
  type: "wall",
  floorId: "eg",
  categoryCode: "20",
  start: { x: 0, y: 0 },
  end: { x: 4, y: 0 },
  wallTypeId: sampleProject.wallTypes[0]?.id ?? "wt1",
  height: 2.6,
};
const wall2: Wall = { ...wall1, id: "w2" };

const drawing1: Drawing2D = {
  id: "d1",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 } },
};
const drawing2: Drawing2D = { ...drawing1, id: "d2" };

function project(overrides: Partial<Project>): Project {
  return {
    ...sampleProject,
    walls: [wall1, wall2],
    drawings2d: [drawing1, drawing2],
    ...overrides,
  };
}

describe("filterProjectToSelection", () => {
  it("behält nur ausgewählte Wände/Zeichnungen, andere Elemente unangetastet", () => {
    const p = project({});
    const next = filterProjectToSelection(p, { wallIds: ["w1"], drawingIds: ["d2"] });
    expect(next.walls.map((w) => w.id)).toEqual(["w1"]);
    expect(next.drawings2d.map((d) => d.id)).toEqual(["d2"]);
    // Bibliotheken/Ebenen unverändert (dieselbe Referenz, nicht kopiert).
    expect(next.wallTypes).toBe(p.wallTypes);
    expect(next.drawingLevels).toBe(p.drawingLevels);
  });

  it("leert eine Art komplett, wenn dafür keine IDs angegeben sind", () => {
    const p = project({});
    const next = filterProjectToSelection(p, { wallIds: ["w1"] });
    expect(next.walls.map((w) => w.id)).toEqual(["w1"]);
    expect(next.drawings2d).toEqual([]);
  });

  it("leert ALLES bei komplett leerer Auswahl (kein Element selektiert)", () => {
    const p = project({});
    const next = filterProjectToSelection(p, {});
    expect(next.walls).toEqual([]);
    expect(next.drawings2d).toEqual([]);
    expect(next.ceilings).toEqual([]);
    expect(next.rooms).toEqual([]);
  });

  it("lässt das Ursprungsprojekt unverändert (Immutabilität)", () => {
    const p = project({});
    filterProjectToSelection(p, { wallIds: ["w1"] });
    expect(p.walls).toHaveLength(2);
  });

  it("ignoriert unbekannte IDs (kein Crash, einfach nicht enthalten)", () => {
    const p = project({});
    const next = filterProjectToSelection(p, { wallIds: ["does-not-exist"] });
    expect(next.walls).toEqual([]);
  });
});

describe("selectionMemberCount", () => {
  it("zählt über alle Arten", () => {
    expect(
      selectionMemberCount({ wallIds: ["w1", "w2"], drawingIds: ["d1"] }),
    ).toBe(3);
  });

  it("liefert 0 bei leerem Objekt", () => {
    expect(selectionMemberCount({})).toBe(0);
  });
});
