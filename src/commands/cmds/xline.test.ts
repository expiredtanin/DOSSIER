/**
 * `xlineCommand` — zwei Punkte → `Drawing2DGeom["xline"]` (nur a/b
 * gespeichert; die „unendliche" Verlängerung passiert beim Rendern).
 */

import { describe, it, expect } from "vitest";
import { xlineCommand } from "./xline";
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

describe("xlineCommand", () => {
  it("zwei Punkte → shape:'xline' mit exakt a/b (keine Verlängerung im Modell)", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterStart] = xlineCommand.onInput(
      xlineCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [, result] = xlineCommand.onInput(
      afterStart,
      { kind: "point", point: { x: 4, y: 0 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("xline");
    if (g.shape === "xline") {
      expect(g.a).toEqual({ x: 0, y: 0 });
      expect(g.b).toEqual({ x: 4, y: 0 });
    }
  });

  it("Null-Strecke (gleicher Punkt) committet nichts", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterStart] = xlineCommand.onInput(
      xlineCommand.init(),
      { kind: "point", point: { x: 1, y: 1 } },
      ctx,
    );
    const [, result] = xlineCommand.onInput(
      afterStart,
      { kind: "point", point: { x: 1, y: 1 } },
      ctx,
    );
    expect(result.commit).toBeUndefined();
    expect(result.done).toBe(true);
  });
});
