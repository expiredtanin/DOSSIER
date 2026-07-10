/**
 * Unit-Tests für Decken-Aussparungen (Treppenauge/Schacht) im 3D-Modell
 * (toWalls3d → emitSlabs, über {@link pickGeometry}): der Brücken-Trick
 * (mergeHoles) liefert je Decken-Schicht denselben erweiterten Slab-Ring.
 */

import { describe, it, expect } from "vitest";
import type { RVec2 } from "./toWalls3d";
import { pickGeometry } from "./toWalls3d";
import type { Project } from "../model/types";
import { sampleProject } from "../model/sampleProject";

/** Shoelace-Fläche eines RVec2-Rings. */
function ringArea(ring: RVec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    s += ax * by - bx * ay;
  }
  return Math.abs(s) / 2;
}

// C1 im sampleProject: Rechteck-Umriss (5x4m, Fläche 20), Deckentyp
// "dg-massiv" mit 3 Schichten (Estrich/Dämmung/Beton) -> 3 Slabs je Decke.
const hole: { x: number; y: number }[] = [
  { x: 2, y: 1.5 },
  { x: 3, y: 1.5 },
  { x: 3, y: 2.5 },
  { x: 2, y: 2.5 },
]; // 1x1, vollständig innerhalb des 5x4-Umrisses

function projectWithHole(): Project {
  return {
    ...sampleProject,
    ceilings: sampleProject.ceilings!.map((c) => (c.id === "C1" ? { ...c, openings: [hole] } : c)),
  };
}

describe("emitSlabs (via pickGeometry) — Decken-Aussparungen", () => {
  it("ohne openings: Slab-Outline unverändert (Regression)", () => {
    const slabs = pickGeometry(sampleProject).slabs.filter((s) => s.ceilingId === "C1");
    expect(slabs.length).toBe(3); // 3 Schichten
    for (const s of slabs) {
      expect(s.outline.length).toBe(4);
      expect(ringArea(s.outline)).toBeCloseTo(20, 2);
    }
  });

  it("mit einem 1x1-Loch: jede Schicht bekommt denselben erweiterten Ring (mehr Vertices, Fläche = Aussen - Loch)", () => {
    const slabs = pickGeometry(projectWithHole()).slabs.filter((s) => s.ceilingId === "C1");
    expect(slabs.length).toBe(3); // Anzahl Schichten unverändert
    for (const s of slabs) {
      // 4 (Aussen) + 4 (Loch) + 2 (Brücken-Duplikate) = 10 Vertices.
      expect(s.outline.length).toBe(10);
      expect(ringArea(s.outline)).toBeCloseTo(20 - 1, 2);
    }
    // Alle Schichten teilen denselben Ring (Brücken-Trick einmal pro Decke).
    const [first, ...rest] = slabs;
    for (const s of rest) expect(s.outline).toEqual(first.outline);
  });
});
