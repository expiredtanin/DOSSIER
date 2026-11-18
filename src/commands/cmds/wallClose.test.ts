/** [287] Wandzug: Klick auf den Startpunkt schliesst den Ring und beendet den Befehl. */
import { describe, it, expect } from "vitest";
import { wallCommand } from "./wall";
import type { CommandContext, CommandResult, Project, Vec2 } from "../types";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "c", thickness: 0.2 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  } as unknown as Project;
}

function makeCtx(): CommandContext {
  const p = project();
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeWallTypeId: "aw",
    lastPoint: null,
  } as unknown as CommandContext;
}

const sq: Vec2[] = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 3 },
  { x: 0, y: 3 },
];

function feed(pts: Vec2[]) {
  const ctx = makeCtx();
  let s = wallCommand.init();
  let last: CommandResult | null = null;
  for (const pt of pts) [s, last] = wallCommand.onInput(s, { kind: "point", point: pt }, ctx);
  return { s, last: last! };
}

describe("wallCommand — Ring schliessen ([287])", () => {
  it("Klick auf den Startpunkt legt den Ring an und beendet den Zug", () => {
    const { s, last } = feed([...sq, sq[0]]);
    expect(last.done).toBe(true);
    expect(last.commit).toBeDefined();
    expect(wallCommand.prompt(s)).toBe("cmd.wall.start");
    expect(last.commit!(project()).walls).toHaveLength(4);
  });

  it("zwei Wände ergeben noch keinen Ring", () => {
    const { last } = feed([sq[0], sq[1], sq[0]]);
    expect(last.done).toBeFalsy();
  });
});
