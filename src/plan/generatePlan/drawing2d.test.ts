/**
 * `addDrawing2D` — Rendering der neuen Freiform-Geometrien (ellipse/bezier/
 * spline): tessellierte Linien-/Polygon-Primitive wie bei polyline/rect,
 * kein eigenes SVG-Primitiv (s. `model/types.ts` Drawing2DGeom-Doku).
 */

import { describe, it, expect } from "vitest";
import { addDrawing2D } from "./drawing2d";
import type { Drawing2D, Project } from "../../model/types";
import type { Primitive } from "./shared";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

const lwByCode = new Map<string, number>();
const colorByCode = new Map<string, string>();
const catByCode = new Map<string, Project["layers"][number]>();

describe("addDrawing2D — ellipse", () => {
  it("gibt eine gefüllte Fläche + geschlossenen Linienzug (64 Segmente) aus", () => {
    const d: Drawing2D = {
      id: "e1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "ellipse", center: { x: 0, y: 0 }, rx: 4, ry: 2, rotation: 0 },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    const polys = out.filter((p) => p.kind === "polygon");
    const lines = out.filter((p) => p.kind === "line");
    expect(polys.length).toBe(1);
    expect(lines.length).toBe(64);
    for (const l of lines) expect(l.drawingId).toBe("e1");
    // Alle Punkte liegen auf der (unrotierten) Ellipse.
    for (const l of lines) {
      const dx = l.a.x / 4, dy = l.a.y / 2;
      expect(dx * dx + dy * dy).toBeCloseTo(1, 3);
    }
  });
});

describe("addDrawing2D — bezier", () => {
  it("ein Segment: tessellierte offene Linienkette, kein Füll-Polygon", () => {
    const d: Drawing2D = {
      id: "b1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "bezier",
        pts: [{ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 3, y: 3 }, { x: 4, y: 0 }],
      },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.every((p) => p.kind === "line")).toBe(true);
    expect(out.length).toBe(24); // segsPerCurve Default
    const lines = out.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");
    expect(lines[0].a).toEqual({ x: 0, y: 0 });
    const last = lines[lines.length - 1];
    expect(last.b.x).toBeCloseTo(4, 6);
    expect(last.b.y).toBeCloseTo(0, 6);
  });
});

describe("addDrawing2D — spline", () => {
  it("offen: tessellierte Linienkette durch die Wegpunkte, kein Füll-Polygon", () => {
    const d: Drawing2D = {
      id: "s1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "spline", pts: [{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 5, y: 1 }], closed: false },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.some((p) => p.kind === "polygon")).toBe(false);
    const lines = out.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");
    expect(lines[0].a).toEqual({ x: 0, y: 0 });
    const last = lines[lines.length - 1];
    expect(last.b.x).toBeCloseTo(5, 6);
    expect(last.b.y).toBeCloseTo(1, 6);
  });

  it("geschlossen: Füll-Polygon + Linienring schliesst zum ersten Punkt", () => {
    const d: Drawing2D = {
      id: "s2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "spline",
        pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
        closed: true,
      },
    };
    const out: Primitive[] = [];
    addDrawing2D(out, project(), d, false, lwByCode, colorByCode, catByCode);
    expect(out.filter((p) => p.kind === "polygon").length).toBe(1);
    const lines = out.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");
    const last = lines[lines.length - 1];
    expect(last.b).toEqual(lines[0].a);
  });
});
