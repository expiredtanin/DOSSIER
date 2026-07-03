/**
 * Unit-Tests für die Wand-Gehrung (computeJoins / miterLine):
 *  • Rechtwinklige L-Ecke: die Gehrung liegt auf der 45°-Diagonalen und trifft
 *    die korrekten Fläche×Fläche-Apexe.
 *  • SPITZE L-Ecke (Öffnungswinkel < 90°): die Gehrung muss weiterhin Außen mit
 *    Außen und Innen mit Innen paaren. Die frühere Distanz-Heuristik kippte hier
 *    und lieferte eine um 90° verdrehte Gehrung (Kreuz-Overlap der Poché-Bänder);
 *    dieser Test fängt den Regress.
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
