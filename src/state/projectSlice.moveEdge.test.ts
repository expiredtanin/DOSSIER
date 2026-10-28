/**
 * Kanten-Griff ziehen (`moveEdgeOf`/`moveRoomEdge` in `projectSlice.ts`) bei
 * Vielecken mit nicht rechtwinkligen Anschlüssen. Nutzer-Report: die
 * Nachbarkanten der verschobenen Seite kippten bisher im WINKEL statt sich
 * nur zu verlängern/verkürzen — der Eckpunkt wurde stur um `delta` versetzt,
 * statt entlang seiner unveränderten Nachbarkante zu wandern. Fix:
 * `movePolygonEdge`/`edgeMoveVertex` schneiden die verschobene Kanten-Linie
 * mit der (unendlich verlängerten) Nachbarkanten-Linie durch den fixen
 * Nachbarpunkt — Nachbarkante behält ihre Richtung, nur ihre Länge ändert
 * sich.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Room } from "../model/types";

// Fünfeck (Haus-Form): P0(0,0) P1(4,0) P2(4,3) P3(2,5) P4(0,3), geschlossen.
const pentagon: Drawing2D = {
  id: "d-pentagon",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "00",
  geom: {
    shape: "polyline",
    closed: true,
    pts: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 2, y: 5 },
      { x: 0, y: 3 },
    ],
  },
};

function makeRoom(over: Partial<Room> = {}): Room {
  return {
    id: "r-pentagon",
    type: "room",
    floorId: "eg",
    categoryCode: "45",
    siaCategory: "HNF",
    name: "Wohnen",
    boundary: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 2, y: 5 },
      { x: 0, y: 3 },
    ],
    color: "#123456",
    ...over,
  };
}

beforeEach(() => {
  setState({
    project: { ...sampleProject, drawings2d: [pentagon], rooms: [makeRoom()] },
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
});

describe("moveEdgeOf — Nachbarkanten winkeltreu (nicht rechtwinklige Ecke)", () => {
  it("verschiebt die slanted Kante P2-P3 und erhält die Richtung der Nachbarkanten", () => {
    // Kante (Index 2,3) = P2(4,3)→P3(2,5) um (1,1) verschieben.
    getState().moveEdgeOf("d-pentagon", null, 2, 3, { x: 1, y: 1 });
    const g = getState().project.drawings2d.find((d) => d.id === "d-pentagon")!.geom;
    expect(g.shape).toBe("polyline");
    if (g.shape !== "polyline") return;
    // P0/P1/P4 unverändert (nicht Teil der gezogenen Kante).
    expect(g.pts[0]).toEqual({ x: 0, y: 0 });
    expect(g.pts[1]).toEqual({ x: 4, y: 0 });
    expect(g.pts[4]).toEqual({ x: 0, y: 3 });
    // P2/P3 wandern entlang ihrer FIXEN Nachbarkanten (P1-P2 senkrecht,
    // P4-P3 diagonal 45°), nicht stur um (1,1) versetzt.
    expect(g.pts[2].x).toBeCloseTo(4, 9);
    expect(g.pts[2].y).toBeCloseTo(5, 9);
    expect(g.pts[3].x).toBeCloseTo(3, 9);
    expect(g.pts[3].y).toBeCloseTo(6, 9);
    // Nachbarkante P1-P2' behält ihre Richtung (senkrecht, Δx=0) — nur die
    // Länge ändert sich (3 → 5).
    const p1 = g.pts[1];
    const p2 = g.pts[2];
    expect(p2.x - p1.x).toBeCloseTo(0, 9);
    expect(p2.y - p1.y).toBeCloseTo(5, 9);
    // Nachbarkante P4-P3' behält ihre Richtung (Steigung 1:1) — nur die
    // Länge ändert sich (√8 → √18).
    const p4 = g.pts[4];
    const p3 = g.pts[3];
    const dir = { x: p3.x - p4.x, y: p3.y - p4.y };
    expect(dir.x).toBeCloseTo(dir.y, 9); // 45°-Steigung erhalten
    expect(Math.hypot(dir.x, dir.y)).toBeGreaterThan(Math.hypot(2, 2)); // länger als vorher
  });

  it("Rechteck (4 rechtwinklige Ecken) bleibt reine Parallel-Verschiebung (Regressionsschutz)", () => {
    const rect: Drawing2D = {
      id: "d-rect",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "00",
      geom: {
        shape: "polyline",
        closed: true,
        pts: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 3 },
          { x: 0, y: 3 },
        ],
      },
    };
    setState({ project: { ...getState().project, drawings2d: [rect] } });
    // Rechte Kante (Index 1,2) um (2,0) nach außen verschieben.
    getState().moveEdgeOf("d-rect", null, 1, 2, { x: 2, y: 0 });
    const g = getState().project.drawings2d.find((d) => d.id === "d-rect")!.geom;
    expect(g.shape).toBe("polyline");
    if (g.shape !== "polyline") return;
    expect(g.pts[0]).toEqual({ x: 0, y: 0 });
    expect(g.pts[1]).toEqual({ x: 6, y: 0 });
    expect(g.pts[2]).toEqual({ x: 6, y: 3 });
    expect(g.pts[3]).toEqual({ x: 0, y: 3 });
  });
});

describe("moveRoomEdge — dieselbe Winkeltreue über movePolygonEdge", () => {
  it("verschiebt die slanted Kante eines Raum-Umrisses winkeltreu", () => {
    getState().moveRoomEdge("r-pentagon", 2, 3, { x: 1, y: 1 });
    const r = getState().project.rooms!.find((x) => x.id === "r-pentagon")!;
    expect(r.boundary[0]).toEqual({ x: 0, y: 0 });
    expect(r.boundary[2].x).toBeCloseTo(4, 9);
    expect(r.boundary[2].y).toBeCloseTo(5, 9);
    expect(r.boundary[3].x).toBeCloseTo(3, 9);
    expect(r.boundary[3].y).toBeCloseTo(6, 9);
  });
});
