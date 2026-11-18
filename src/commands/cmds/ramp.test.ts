/**
 * [281] `rampCommand` — Umriss, Gefällelinie, Gefälle in %: eine Decke mit `slope` (Rampe), OK am Anfang auf dem
 * Geschossboden; Enter beim Gefälle übernimmt 6 %.
 */
import { describe, expect, it } from "vitest";
import { rampCommand, RAMP_DEFAULT_PERCENT } from "./ramp";
import type { CommandContext, CommandState, Project, Vec2 } from "../types";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "beton", name: "Beton", color: "#999999", joinPriority: 100 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "beton", thickness: 0.2 }] }],
    ceilingTypes: [{ id: "ct", name: "Platte", layers: [{ componentId: "beton", thickness: 0.25 }] }],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers: [{ code: "30", name: "Decken", color: "#000000", lw: 0.35, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  } as unknown as Project;
}

const ctxOf = (p: Project): CommandContext => ({
  project: p,
  level: p.drawingLevels[0],
  defaultCategoryCode: "30",
  activeLineStyleId: "solid",
  activeWallTypeId: "aw",
  lastPoint: null,
  selection: { wallIds: [], drawingId: null },
});

function run(pts: Vec2[], percent: number | null): Project {
  const p = project();
  const ctx = ctxOf(p);
  let state: CommandState = rampCommand.init();
  let commit: ((q: Project) => Project) | undefined;
  for (const point of pts) {
    const [ns, res] = rampCommand.onInput(state, { kind: "point", point }, ctx);
    state = ns;
    commit = res.commit ?? commit;
  }
  const [, res] = percent === null ? rampCommand.onConfirm(state, ctx) : rampCommand.onInput(state, { kind: "number", value: percent }, ctx);
  commit = res.commit ?? commit;
  return commit ? commit(p) : p;
}

const outline: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 3 },
  { x: 0, y: 3 },
  { x: 0, y: 0 }, // Klick auf den Startpunkt schliesst
];

describe("rampCommand", () => {
  it("Umriss + Gefällelinie + −15 % ergibt eine abwärts geneigte Rampe", () => {
    const q = run([...outline, { x: 0, y: 1.5 }, { x: 10, y: 1.5 }], -15);
    const c = q.ceilings![0];
    expect(c.slope?.ramp).toBe(true);
    expect(c.slope?.rise).toBeCloseTo(-1.5, 9);
    expect(c.slope?.from).toEqual({ x: 0, y: 1.5 });
    expect(c.top).toEqual({ mode: "floor", floorId: "eg", offset: 0 });
  });

  it("Enter beim Gefälle übernimmt die Vorgabe (6 %)", () => {
    const q = run([...outline, { x: 0, y: 1.5 }, { x: 5, y: 1.5 }], null);
    expect(q.ceilings![0].slope?.rise).toBeCloseTo((RAMP_DEFAULT_PERCENT / 100) * 5, 9);
  });

  it("Gefälle 0 legt nichts an", () => {
    const q = run([...outline, { x: 0, y: 1.5 }, { x: 5, y: 1.5 }], 0);
    expect(q.ceilings ?? []).toHaveLength(0);
  });
});
