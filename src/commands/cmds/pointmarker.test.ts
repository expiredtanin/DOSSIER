/**
 * `pointmarkerCommand` — ein Klick → `shape:"pointmarker"` an genau diesem
 * Punkt (kein Label, keine weiteren Felder, s. Kopfkommentar in
 * `pointmarker.ts`).
 */

import { describe, it, expect } from "vitest";
import { pointmarkerCommand } from "./pointmarker";
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

describe("pointmarkerCommand", () => {
  it("ein Klick committet shape:'pointmarker' an genau diesem Punkt", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [, result] = pointmarkerCommand.onInput(
      pointmarkerCommand.init(),
      { kind: "point", point: { x: 4, y: 2 } },
      ctx,
    );
    expect(result.done).toBe(true);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("pointmarker");
    if (g.shape === "pointmarker") {
      expect(g.at).toEqual({ x: 4, y: 2 });
    }
  });

  it("jeder weitere Klick platziert ein WEITERES, unabhängiges Symbol", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [, r1] = pointmarkerCommand.onInput(pointmarkerCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    let next = r1.commit!(p);
    const [, r2] = pointmarkerCommand.onInput(pointmarkerCommand.init(), { kind: "point", point: { x: 5, y: 5 } }, ctx);
    next = r2.commit!(next);
    expect(next.drawings2d.length).toBe(2);
    expect(next.drawings2d[0].id).not.toBe(next.drawings2d[1].id);
  });

  it("onConfirm/onCancel kehren in den Ruhezustand zurück (kein Commit)", () => {
    const ctx = makeCtx(project());
    const [, res1] = pointmarkerCommand.onConfirm(pointmarkerCommand.init(), ctx);
    expect(res1.commit).toBeUndefined();
    expect(res1.done).toBe(true);
    const [, res2] = pointmarkerCommand.onCancel(pointmarkerCommand.init());
    expect(res2.commit).toBeUndefined();
    expect(res2.done).toBe(true);
  });
});
