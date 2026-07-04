/**
 * Unit-Tests für den Wand-Schichttrennlinien-Snap:
 *  • `wallLayerBoundarySegments` muss die kumulierten Schicht-Offsets EXAKT so
 *    berechnen wie `addWallPoche` in `plan/generatePlan.ts` (Start bei
 *    `refOff − total/2`, danach `+= layer.thickness` je Schicht, inkl. beider
 *    Aussenflächen) — inklusive Referenzversatz (`center`/`left`/`right`).
 *  • `computeSnap` muss auf diesen Grenzlinien fangen (Endpunkt-Snap ist per
 *    Default aktiv), damit z. B. ein Decken-Umrisspunkt an einer einzelnen
 *    Wandschicht statt nur an Achse/Aussenkante enden kann.
 */

import { describe, it, expect } from "vitest";
import { computeSnap, wallLayerBoundarySegments } from "./snapping";
import { DEFAULT_SNAP } from "./types";
import type { Project, Vec2, Wall } from "../model/types";

/** Minimalprojekt mit einer dreischichtigen Wand (0.1 / 0.15 / 0.2 m). */
function wallProject(wall: Wall): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [
      {
        id: "aw",
        name: "AW",
        layers: [
          { componentId: "c", thickness: 0.1 },
          { componentId: "c", thickness: 0.15 },
          { componentId: "c", thickness: 0.2 },
        ],
      },
    ],
    drawingLevels: [
      {
        id: "eg",
        name: "EG",
        kind: "floor",
        visible: true,
        locked: false,
        floorHeight: 2.6,
        cutHeight: 1.0,
        baseElevation: 0,
      },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [wall],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

function wall(id: string, start: Vec2, end: Vec2, referenceLine?: Wall["referenceLine"]): Wall {
  return {
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "aw",
    height: 2.6,
    referenceLine,
  };
}

describe("wallLayerBoundarySegments", () => {
  it("liefert layers.length+1 Grenzlinien mit kumulierten Offsets (referenceLine=center)", () => {
    const w = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 });
    const segs = wallLayerBoundarySegments(wallProject(w), w);
    expect(segs).toHaveLength(4); // 3 Schichten → 4 Grenzlinien
    // Achse horizontal → leftNormal = (0,1); Offset erscheint als y-Koordinate.
    const offsets = segs.map(([a]) => a.y);
    expect(offsets[0]).toBeCloseTo(-0.225, 9); // −T/2 (Aussenfläche)
    expect(offsets[1]).toBeCloseTo(-0.125, 9); // −T/2 + 0.10
    expect(offsets[2]).toBeCloseTo(0.025, 9); // −T/2 + 0.10 + 0.15
    expect(offsets[3]).toBeCloseTo(0.225, 9); // +T/2 (Aussenfläche, innen)
    // Jede Grenzlinie läuft parallel zur Achse über die volle Wandlänge.
    for (const [a, b] of segs) {
      expect(a.y).toBeCloseTo(b.y, 9);
      expect(a.x).toBeCloseTo(0, 9);
      expect(b.x).toBeCloseTo(4, 9);
    }
  });

  it("verschiebt die Offsets um wallReferenceOffset bei referenceLine=left/right", () => {
    const wLeft = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 }, "left");
    const offLeft = wallLayerBoundarySegments(wallProject(wLeft), wLeft).map(([a]) => a.y);
    // refOff = +T/2 = 0.225 → Offsets laufen von 0 bis T (0.45).
    expect(offLeft[0]).toBeCloseTo(0, 9);
    expect(offLeft[3]).toBeCloseTo(0.45, 9);

    const wRight = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 }, "right");
    const offRight = wallLayerBoundarySegments(wallProject(wRight), wRight).map(([a]) => a.y);
    // refOff = −T/2 = −0.225 → Offsets laufen von −0.45 bis 0.
    expect(offRight[0]).toBeCloseTo(-0.45, 9);
    expect(offRight[3]).toBeCloseTo(0, 9);
  });

  it("liefert eine leere Liste bei unbekanntem Wandtyp (kein Crash im Snap-Pfad)", () => {
    const w = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 });
    w.wallTypeId = "unknown";
    expect(wallLayerBoundarySegments(wallProject(w), w)).toEqual([]);
  });
});

describe("computeSnap — fängt auf Wand-Schichttrennlinien", () => {
  it("fängt den Endpunkt einer inneren Schichtgrenze (nicht nur Achse/Aussenkante)", () => {
    const w = wall("W1", { x: 0, y: 0 }, { x: 4, y: 0 });
    const project = wallProject(w);
    // Endpunkt der Schichtgrenze bei y=0.025 (Fuge zwischen Schicht 2 und 3).
    const raw: Vec2 = { x: 0.01, y: 0.02 };
    const result = computeSnap({
      raw,
      project,
      levelId: "eg",
      visibleCodes: new Set(["20"]),
      settings: DEFAULT_SNAP,
      draftPoints: [],
      lastPoint: null,
      pxPerMeter: 100,
      shift: false,
      ctrl: false,
    });
    expect(result).not.toBeNull();
    expect(result!.point.x).toBeCloseTo(0, 6);
    expect(result!.point.y).toBeCloseTo(0.025, 6);
  });
});
