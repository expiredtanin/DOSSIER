/**
 * `ellipseCommand` — zwei Bounding-Box-Ecken → achsparallele Ellipse
 * (shape:"ellipse", rotation 0).
 */

import { describe, it, expect } from "vitest";
import { ellipseCommand } from "./ellipse";
import type { CommandContext, Project } from "../types";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
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

function makeCtx(p: Project): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null },
  };
}

describe("ellipseCommand", () => {
  it("zwei Ecken → Zentrum + Halbachsen aus der Bounding-Box, rotation 0", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterCorner1] = ellipseCommand.onInput(
      ellipseCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [, result] = ellipseCommand.onInput(
      afterCorner1,
      { kind: "point", point: { x: 8, y: 4 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("ellipse");
    if (g.shape === "ellipse") {
      expect(g.center).toEqual({ x: 4, y: 2 });
      expect(g.rx).toBeCloseTo(4, 6);
      expect(g.ry).toBeCloseTo(2, 6);
      expect(g.rotation).toBe(0);
    }
  });

  it("entartete Bbox (Punkt=Punkt) committet nichts", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterCorner1] = ellipseCommand.onInput(
      ellipseCommand.init(),
      { kind: "point", point: { x: 5, y: 5 } },
      ctx,
    );
    const [, result] = ellipseCommand.onInput(
      afterCorner1,
      { kind: "point", point: { x: 5, y: 5 } },
      ctx,
    );
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(0);
  });
});
