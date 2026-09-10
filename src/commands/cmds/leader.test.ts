/**
 * `leaderCommand` — Zielpunkt + Textanker → leeres `text`-Element mit
 * `leaderTarget` gesetzt, meldet `focusDrawingId` (öffnet den Inline-Editor).
 */

import { describe, it, expect } from "vitest";
import { leaderCommand } from "./leader";
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

describe("leaderCommand", () => {
  it("Zielpunkt + Anker → leeres Text-Element mit leaderTarget, focusDrawingId gesetzt", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterTarget] = leaderCommand.onInput(
      leaderCommand.init(),
      { kind: "point", point: { x: 10, y: 10 } },
      ctx,
    );
    const [, result] = leaderCommand.onInput(
      afterTarget,
      { kind: "point", point: { x: 2, y: 2 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    expect(result.focusDrawingId).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.text).toBe("");
      expect(g.at).toEqual({ x: 2, y: 2 });
      expect(g.leaderTarget).toEqual({ x: 10, y: 10 });
    }
    expect(next.drawings2d[0].id).toBe(result.focusDrawingId);
  });
});
