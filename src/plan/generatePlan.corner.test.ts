/**
 * Unit-Tests für die Wandecken-Gehrung im Grundriss (generatePlan):
 *  • KEINE 45°-Naht zwischen gleichfarbigen Schichten zweier Wände am Knoten
 *    (die inneren Gehrungs-Stirnkanten tragen `noStrokeEdges`).
 *  • KEIN überschießender Umriss-Barb: die Gehrungs-Diagonale ist der Umriss
 *    nicht mehr gestrichen; die Cut-Ecken sitzen exakt auf den Fläche×Fläche-
 *    Apexen (sauberer Miter, kein Overshoot).
 *  • Freie (rechtwinklige) Wandenden bleiben voll umrissen (kein noStrokeEdges).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Project, Wall } from "../model/types";

/** Minimalprojekt: zwei Wände, die in (5,0) eine 90°-L-Ecke bilden. */
function cornerProject(): Project {
  const wall = (id: string, start: Wall["start"], end: Wall["end"]): Wall => ({
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "aw",
    height: 2.6,
  });
  return {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [
      { id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 },
      { id: "b", name: "B", color: "#8c5544", hatchId: "none", joinPriority: 50 },
    ],
    wallTypes: [
      {
        id: "aw",
        name: "AW",
        layers: [
          { componentId: "a", thickness: 0.1 },
          { componentId: "b", thickness: 0.245 },
        ],
      },
    ],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [
      // W1 endet in (5,0); W2 startet in (5,0) → geteilter Knoten (L-Ecke).
      wall("W1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      wall("W2", { x: 5, y: 0 }, { x: 5, y: 4 }),
    ],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

const visible = new Set(["20"]);

describe("generatePlan — Wandecken-Gehrung", () => {
  it("markiert die Gehrungs-Stirnkante am Knoten als nicht zu stricheln (keine Naht/Barbe)", () => {
    const plan = generatePlan(cornerProject(), "eg", visible, undefined, "mittel");
    const wallPolys = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> =>
        p.kind === "polygon" && p.wallId != null,
    );
    expect(wallPolys.length).toBeGreaterThan(0);
    // JEDES Wandpolygon (Schichtbänder + Umriss) trägt an genau EINEM Ende die
    // Gehrungs-Stirnkante: W1 am Endcut (Kante 1), W2 am Startcut (Kante 3).
    const w1 = wallPolys.filter((p) => p.wallId === "W1");
    const w2 = wallPolys.filter((p) => p.wallId === "W2");
    expect(w1.length).toBeGreaterThan(0);
    expect(w2.length).toBeGreaterThan(0);
    for (const p of w1) expect(p.noStrokeEdges).toEqual([1]);
    for (const p of w2) expect(p.noStrokeEdges).toEqual([3]);
  });

  it("legt die Umriss-Cut-Ecken exakt auf die Fläche×Fläche-Apexe (sauberer Miter, kein Overshoot)", () => {
    const plan = generatePlan(cornerProject(), "eg", visible, undefined, "mittel");
    // Der Wand-Umriss ist das letzte Wandpolygon je Wand (fill:"none").
    const outlineW1 = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> =>
        p.kind === "polygon" && p.wallId === "W1" && p.fill === "none",
    );
    expect(outlineW1.length).toBe(1);
    const o = outlineW1[0];
    // clippedBand-Reihenfolge [A.start, A.end, B.end, B.start]; A.end/B.end sind
    // die getrimmten Enden am Knoten. T=0.345, half=0.1725. Aussen-Apex=(5.1725,
    // -0.1725), Innen-Apex=(4.8275, 0.1725) — der EXAKTE 90°-Miter ohne Überstand.
    const half = 0.345 / 2;
    expect(o.pts[1].x).toBeCloseTo(5 + half, 4); // A.end (Aussenfläche)
    expect(o.pts[1].y).toBeCloseTo(-half, 4);
    expect(o.pts[2].x).toBeCloseTo(5 - half, 4); // B.end (Innenfläche)
    expect(o.pts[2].y).toBeCloseTo(half, 4);
  });

  it("lässt freie (rechtwinklige) Wandenden voll umrissen (kein noStrokeEdges dort)", () => {
    // Nur W1 allein → beide Enden frei, kein Knoten.
    const proj = cornerProject();
    proj.walls = [proj.walls[0]];
    const plan = generatePlan(proj, "eg", visible, undefined, "mittel");
    const wallPolys = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> =>
        p.kind === "polygon" && p.wallId === "W1",
    );
    expect(wallPolys.length).toBeGreaterThan(0);
    for (const p of wallPolys) expect(p.noStrokeEdges).toEqual([]);
  });
});
