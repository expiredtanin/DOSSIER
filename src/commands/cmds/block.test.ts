/**
 * `blockCommand` — Einfügepunkt → neue `{shape:"block"}`-Instanz, die auf
 * die aktuell per Option gewählte `BlockDef` zeigt. Ohne Definitionen: No-Op.
 */

import { describe, it, expect } from "vitest";
import { blockCommand } from "./block";
import type { CommandContext, Project } from "../types";
import type { BlockDef } from "../../model/types";

function project(blockDefs: BlockDef[] = []): Project {
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
    blockDefs,
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

describe("blockCommand", () => {
  it("ohne definierte Blöcke: Klick committet nichts", () => {
    const p = project([]);
    const ctx = makeCtx(p);
    const [, result] = blockCommand.onInput(
      blockCommand.init(),
      { kind: "point", point: { x: 1, y: 1 } },
      ctx,
    );
    expect(result.commit).toBeUndefined();
    expect(result.done).toBe(true);
  });

  it("mit einer Definition: Klick platziert eine Instanz an der Klickposition, rotation 0", () => {
    const def: BlockDef = { id: "blk1", name: "Stuhl", geom2d: [{ shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }] };
    const p = project([def]);
    const ctx = makeCtx(p);
    const [, result] = blockCommand.onInput(
      blockCommand.init(),
      { kind: "point", point: { x: 3, y: 4 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("block");
    if (g.shape === "block") {
      expect(g.blockDefId).toBe("blk1");
      expect(g.at).toEqual({ x: 3, y: 4 });
      expect(g.rotation).toBe(0);
    }
  });
});
