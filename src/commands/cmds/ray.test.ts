/**
 * `rayCommand` — zwei Punkte → `Drawing2DGeom["ray"]` (nur a/b gespeichert;
 * die einseitige „unendliche" Verlängerung über `b` hinaus passiert beim
 * Rendern, `a` bleibt der feste Anker).
 */

import { describe, it, expect } from "vitest";
import { rayCommand } from "./ray";
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

describe("rayCommand", () => {
  it("zwei Punkte → shape:'ray' mit exakt a/b (keine Verlängerung im Modell)", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterStart] = rayCommand.onInput(
      rayCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [, result] = rayCommand.onInput(
      afterStart,
      { kind: "point", point: { x: 4, y: 0 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("ray");
    if (g.shape === "ray") {
      expect(g.a).toEqual({ x: 0, y: 0 });
      expect(g.b).toEqual({ x: 4, y: 0 });
    }
  });

  it("Null-Strecke (gleicher Punkt) committet nichts", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterStart] = rayCommand.onInput(
      rayCommand.init(),
      { kind: "point", point: { x: 1, y: 1 } },
      ctx,
    );
    const [, result] = rayCommand.onInput(
      afterStart,
      { kind: "point", point: { x: 1, y: 1 } },
      ctx,
    );
    expect(result.commit).toBeUndefined();
    expect(result.done).toBe(true);
  });
});
