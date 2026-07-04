/**
 * Unit-Tests für die Wand-Gehrung (computeJoins / miterLine):
 *  • Rechtwinklige L-Ecke: die Gehrung liegt auf der 45°-Diagonalen und trifft
 *    die korrekten Fläche×Fläche-Apexe.
 *  • SPITZE L-Ecke (Öffnungswinkel < 90°): die Gehrung muss weiterhin Außen mit
 *    Außen und Innen mit Innen paaren. Die frühere Distanz-Heuristik kippte hier
 *    und lieferte eine um 90° verdrehte Gehrung (Kreuz-Overlap der Poché-Bänder);
 *    dieser Test fängt den Regress.
 *  • T-Knoten (drei Wandenden am selben Punkt): das abzweigende Ende bekommt
 *    einen Schnitt auf der zugewandten Fläche der Durchgangswand, die beiden
 *    kollinearen Enden bleiben ungeschnitten.
 *  • Mittelspannen-T-Stoß: ein freies Ende, das mitten auf die Seite einer
 *    anderen Wand trifft, bekommt einen Schnitt auf deren Fläche; ohne Treffer
 *    bleibt es rechtwinklig (null).
 */

import { describe, it, expect } from "vitest";
import { computeJoins } from "./joins";
import { cross, len, sub } from "./geometry";
import type { Line } from "./geometry";
import type { Project, Vec2, Wall } from "./types";

/** Abstand eines Punktes P von der unendlichen Geraden `line`. */
function distToLine(line: Line, p: Vec2): number {
  return Math.abs(cross(line.dir, sub(p, line.point))) / len(line.dir);
}

/** Minimalprojekt aus zwei Wänden mit einem Wandtyp gegebener Gesamtdicke. */
function twoWallProject(w1: Wall, w2: Wall, thickness: number): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [
      { id: "aw", name: "AW", layers: [{ componentId: "c", thickness }] },
    ],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [w1, w2],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

/** Minimalprojekt aus drei Wänden mit einem Wandtyp gegebener Gesamtdicke. */
function threeWallProject(
  w1: Wall,
  w2: Wall,
  w3: Wall,
  thickness: number,
): Project {
  const proj = twoWallProject(w1, w2, thickness);
  proj.walls = [w1, w2, w3];
  return proj;
}

function wall(id: string, start: Vec2, end: Vec2): Wall {
  return {
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "aw",
    height: 2.6,
  };
}

describe("computeJoins — Gehrung an der L-Ecke", () => {
  it("legt die rechtwinklige Gehrung auf die 45°-Diagonale (Fläche×Fläche-Apexe)", () => {
    // W1 (0,0)→(5,0), W2 (5,0)→(5,4); Knoten (5,0). T=0.4, half=0.2.
    const proj = twoWallProject(
      wall("W1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      wall("W2", { x: 5, y: 0 }, { x: 5, y: 4 }),
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);
    const cut = joins.get("W1")!.endCut;
    expect(cut).not.toBeNull();
    // Außen-Apex (5.2,−0.2) und Innen-Apex (4.8,0.2) liegen auf der Gehrung;
    // Richtung ist die 45°-Diagonale.
    expect(distToLine(cut!, { x: 5.2, y: -0.2 })).toBeCloseTo(0, 6);
    expect(distToLine(cut!, { x: 4.8, y: 0.2 })).toBeCloseTo(0, 6);
    expect(Math.abs(cut!.dir.x)).toBeCloseTo(Math.abs(cut!.dir.y), 6);
  });

  it("paart bei SPITZEM Winkel Außen-mit-Außen und Innen-mit-Innen (kein Kreuz-Overlap)", () => {
    // Symmetrische V-Ecke, Knoten (0,0), Öffnungswinkel 60° (spitz), nach oben.
    // Beide Wandkörper laufen unter ±30° zur +y-Achse aus:
    //   gA = (−sin30, cos30) = (−0.5, √3/2), gB = (+0.5, √3/2).
    // W_A: end im Knoten (start = gA·2), W_B: start im Knoten (end = gB·2).
    const s3 = Math.sqrt(3) / 2;
    const proj = twoWallProject(
      wall("WA", { x: -1, y: 2 * s3 }, { x: 0, y: 0 }),
      wall("WB", { x: 0, y: 0 }, { x: 1, y: 2 * s3 }),
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);
    // Beide Wände teilen dieselbe Gehrung; WA endet im Knoten, WB startet dort.
    const cut = joins.get("WA")!.endCut ?? joins.get("WB")!.startCut;
    expect(cut).not.toBeNull();

    // Korrekt: Außen-Apex (0,−0.4) und Innen-Apex (0,0.4) → vertikale Gehrung
    // (Richtung parallel zur y-Achse). Die buggy Distanz-Heuristik lieferte
    // stattdessen eine HORIZONTALE Gehrung (Apexe (±0.23,0)) → hier rot.
    expect(distToLine(cut!, { x: 0, y: -0.4 })).toBeCloseTo(0, 6);
    expect(distToLine(cut!, { x: 0, y: 0.4 })).toBeCloseTo(0, 6);
    // Gehrung vertikal: dir.x ≈ 0 (die falsche, horizontale Gehrung hätte dir.y ≈ 0).
    const dir = cut!.dir;
    expect(Math.abs(dir.x) / len(dir)).toBeCloseTo(0, 6);
  });
});

describe("computeJoins — T-Knoten (drei Wandenden am selben Punkt)", () => {
  it("schneidet nur das abzweigende Ende, auf der zugewandten Fläche der Durchgangswand", () => {
    // Durchgangswand in zwei Hälften WA1 (0,0)→(5,0) und WA2 (5,0)→(10,0),
    // Abzweig WB (5,0)→(5,3) nach oben. T=0.4 → halbe Dicke 0.2.
    const proj = threeWallProject(
      wall("WA1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      wall("WA2", { x: 5, y: 0 }, { x: 10, y: 0 }),
      wall("WB", { x: 5, y: 0 }, { x: 5, y: 3 }),
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);

    // Die kollinearen Hälften der Durchgangswand bleiben ungeschnitten.
    expect(joins.get("WA1")!.endCut).toBeNull();
    expect(joins.get("WA2")!.startCut).toBeNull();

    // Der Abzweig bekommt einen Schnitt auf der ihm zugewandten (oberen)
    // Fläche der Durchgangswand: die horizontale Gerade y = 0.2.
    const cut = joins.get("WB")!.startCut;
    expect(cut).not.toBeNull();
    expect(distToLine(cut!, { x: 5, y: 0.2 })).toBeCloseTo(0, 6);
    expect(distToLine(cut!, { x: 0, y: 0.2 })).toBeCloseTo(0, 6);
    // Gehrungsgerade horizontal (parallel zur Durchgangsachse).
    expect(Math.abs(cut!.dir.y) / len(cut!.dir)).toBeCloseTo(0, 6);
  });
});

describe("computeJoins — Mittelspannen-T-Stoß (Ende trifft Wandseite)", () => {
  it("schneidet ein freies Ende, das auf die Seite einer anderen Wand trifft, entlang deren Fläche", () => {
    // Durchgangswand W (0,0)→(10,0), T=0.4 → halbe Dicke 0.2. Abzweig WB2
    // trifft mit seinem freien Ende (4, 0.2) genau auf die obere Fläche.
    const proj = threeWallProject(
      wall("W", { x: 0, y: 0 }, { x: 10, y: 0 }),
      wall("WB2", { x: 4, y: 3 }, { x: 4, y: 0.2 }),
      wall("Filler", { x: 100, y: 100 }, { x: 100, y: 103 }), // unbeteiligt
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);

    const cut = joins.get("WB2")!.endCut;
    expect(cut).not.toBeNull();
    expect(distToLine(cut!, { x: 0, y: 0.2 })).toBeCloseTo(0, 6);
    expect(distToLine(cut!, { x: 5, y: 0.2 })).toBeCloseTo(0, 6);
    expect(Math.abs(cut!.dir.y) / len(cut!.dir)).toBeCloseTo(0, 6);

    // Die Wand W selbst bleibt an ihren (freien) Enden ungeschnitten.
    expect(joins.get("W")!.startCut).toBeNull();
    expect(joins.get("W")!.endCut).toBeNull();
    // Das obere, unbeteiligte Ende von WB2 bleibt ebenfalls ungeschnitten.
    expect(joins.get("WB2")!.startCut).toBeNull();
  });

  it("lässt ein freies Ende rechtwinklig (null), wenn keine Wand nah genug getroffen wird", () => {
    // Gleiche Anordnung, aber Abzweig-Ende bei y=0.5 — außerhalb der
    // Wandfläche (Dicke/2 + Toleranz = 0.201).
    const proj = twoWallProject(
      wall("W", { x: 0, y: 0 }, { x: 10, y: 0 }),
      wall("WB3", { x: 4, y: 3 }, { x: 4, y: 0.5 }),
      0.4,
    );
    const joins = computeJoins(proj, proj.walls);
    expect(joins.get("WB3")!.endCut).toBeNull();
  });
});
