// Punkttypen einer Polylinie: Rechnung im Kern (`polyline_vertex.rs`, eigene Rust-Tests); hier die
// Fassade für das Kontextmenü und die Store-Aktion `setPolylineVertexType` (Griff-Änderung im Kern).
import { describe, expect, it } from "vitest";
import { bulgeArc, bulgeArcPoints } from "./bulge";
import { canSetVertexType, vertexTypeOf } from "./polylineVertexType";
import { getState } from "../state/appStore";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Vec2 } from "../model/types";

const g = { pts: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 }, { x: 6, y: 1 }], closed: false };

/** Setzt den Punkttyp über den Store und liefert die Bulges (fehlend = alle gerade). */
function setType(pts: Vec2[], closed: boolean, i: number, type: "corner" | "arc" | "spline", bulge?: number[]): number[] | undefined {
  const d = { id: "pl", levelId: sampleProject.drawingLevels[0].id, categoryCode: "01", geom: { shape: "polyline", pts, closed, ...(bulge ? { bulge } : {}) } };
  getState().loadProject({ ...structuredClone(sampleProject), drawings2d: [d as Drawing2D] });
  getState().setPolylineVertexType("pl", i, type);
  const geom = getState().project.drawings2d[0].geom;
  return geom.shape === "polyline" ? geom.bulge : undefined;
}

describe("Punkttypen einer Polylinie", () => {
  it("Eckpunkt setzt beide Nachbarsegmente gerade", () => {
    expect(setType(g.pts, false, 1, "corner", [0.3, -0.2, 0.1])).toEqual([0, 0, 0.1]);
    expect(setType(g.pts, false, 1, "corner", [0.3, -0.2, 0])).toBeUndefined();
  });

  it("Bogenpunkt: beide Segmente liegen auf EINEM Kreis durch die drei Punkte", () => {
    const b = setType(g.pts, false, 1, "arc")!;
    const a1 = bulgeArc(g.pts[0], g.pts[1], b[0])!;
    const a2 = bulgeArc(g.pts[1], g.pts[2], b[1])!;
    expect(Math.hypot(a1.center.x - a2.center.x, a1.center.y - a2.center.y)).toBeLessThan(1e-6);
    expect(a1.r).toBeCloseTo(a2.r, 6);
    expect(vertexTypeOf({ ...g, bulge: b }, 1)).toBe("arc");
    // Die Bögen bauchen NACH OBEN aus (Punkt 1 liegt oben) — kein Zickzack über den Kreis
    const mid1 = bulgeArcPoints(g.pts[0], g.pts[1], b[0]);
    expect(mid1[(mid1.length / 2) | 0].y).toBeGreaterThan(0.5);
  });

  it("Splinepunkt: Typ wird erkannt, offene Enden lassen nur die Ecke zu", () => {
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 5, y: 0.2 }];
    expect(vertexTypeOf({ pts, closed: false, bulge: setType(pts, false, 1, "spline") }, 1)).toBe("spline");
    expect(vertexTypeOf(g, 1)).toBe("corner");
    expect(canSetVertexType(g, 0, "arc")).toBe(false);
    expect(canSetVertexType(g, 3, "spline")).toBe(false);
    expect(canSetVertexType(g, 0, "corner")).toBe(true);
    expect(canSetVertexType(g, 1, "spline")).toBe(true);
  });

  it("geschlossene Polylinie: erster Punkt hat beide Nachbarn; gesperrt ändert nichts", () => {
    const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const b = setType(sq, true, 0, "arc")!;
    expect(b.length).toBe(4);
    expect(b[3]).not.toBe(0);
    expect(b[0]).not.toBe(0);
    expect(b[1]).toBe(0);
    const depth = getState().undoDepth;
    getState().updateDrawing2D("pl", { locked: true });
    getState().setPolylineVertexType("pl", 0, "corner");
    expect(getState().undoDepth).toBe(depth + 1);
  });
});
