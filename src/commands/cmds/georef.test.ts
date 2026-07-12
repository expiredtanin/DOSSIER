import { describe, it, expect } from "vitest";
import { georefCommand } from "./georef";
import type { CommandContext, Project, Vec2 } from "../types";

const ctx = {} as CommandContext;
const P = (x: number, y: number): Vec2 => ({ x, y });

function projectWith(wallStart: Vec2): Project {
  return {
    id: "p",
    name: "T",
    layers: [],
    drawingLevels: [],
    walls: [
      {
        id: "W1",
        type: "wall",
        floorId: "eg",
        categoryCode: "20",
        start: wallStart,
        end: { x: wallStart.x + 5, y: wallStart.y },
        wallTypeId: "aw",
        height: 2.6,
      },
    ],
    drawings2d: [],
  } as unknown as Project;
}

describe("georefCommand", () => {
  it("Hover zeigt die resultierende Verschiebung im HUD (negativer Klickpunkt)", () => {
    const s0 = georefCommand.init();
    const [, r] = georefCommand.onMove(s0, P(120, 45), null, ctx);
    expect(r.draft?.hud).toEqual({ at: P(120, 45), dx: -120, dy: -45 });
  });

  it("Klick committet sofort: der geklickte Punkt wird zum neuen Ursprung", () => {
    const s0 = georefCommand.init();
    const [ns, r] = georefCommand.onInput(s0, { kind: "point", point: P(120, 45) }, ctx);
    expect(r.done).toBe(true);
    expect((ns as { phase: string }).phase).toBe("start");
    const p = projectWith({ x: 120, y: 45 });
    const out = r.commit!(p);
    // Die Wand begann exakt am geklickten Punkt -> liegt danach auf (0,0).
    expect(out.walls[0].start).toEqual({ x: 0, y: 0 });
    expect(out.walls[0].end).toEqual({ x: 5, y: 0 });
  });

  it("Esc/Rechtsklick auf leerem Zustand beendet ohne Commit", () => {
    const s0 = georefCommand.init();
    const [, r1] = georefCommand.onCancel(s0);
    expect(r1.done).toBe(true);
    expect(r1.commit).toBeUndefined();
    const [, r2] = georefCommand.onConfirm(s0, ctx);
    expect(r2.done).toBe(true);
    expect(r2.commit).toBeUndefined();
  });
});
