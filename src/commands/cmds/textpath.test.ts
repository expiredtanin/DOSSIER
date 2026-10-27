/**
 * `textpathCommand` — mind. 2 Pfadpunkte + Enter → leeres `text`-Element mit
 * `pathPts` gesetzt, meldet `focusDrawingId` (öffnet den Inline-Editor).
 */

import { describe, it, expect } from "vitest";
import { textpathCommand } from "./textpath";
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

describe("textpathCommand", () => {
  it("2 Punkte + Enter → leeres Text-Element mit pathPts, focusDrawingId gesetzt", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterA] = textpathCommand.onInput(
      textpathCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [afterB] = textpathCommand.onInput(afterA, { kind: "point", point: { x: 3, y: 2 } }, ctx);
    const [, result] = textpathCommand.onConfirm(afterB, ctx);
    expect(result.commit).toBeDefined();
    expect(result.focusDrawingId).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.text).toBe("");
      expect(g.pathPts).toEqual([{ x: 0, y: 0 }, { x: 3, y: 2 }]);
      expect(g.at).toEqual({ x: 0, y: 0 });
    }
  });

  it("Enter mit nur 1 Punkt committet nichts", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterA] = textpathCommand.onInput(
      textpathCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [, result] = textpathCommand.onConfirm(afterA, ctx);
    expect(result.commit).toBeUndefined();
  });
});
