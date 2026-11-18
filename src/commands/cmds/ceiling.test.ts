/**
 * [285] `ceilingCommand` — Option „Lage": Geschossdecke (oben, wie bisher), Bodenplatte unter dem Geschoss, frei (Oberkante getippt).
 */
import { describe, expect, it } from "vitest";
import { ceilingCommand } from "./ceiling";
import type { CommandContext, CmdInput, CommandState, Project, Vec2 } from "../types";

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

const outline: Vec2[] = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 3 },
  { x: 0, y: 3 },
];

/** Eingaben nacheinander; liefert das Projekt nach dem Commit. */
function run(inputs: CmdInput[]): Project {
  const p = project();
  const ctx = ctxOf(p);
  let state: CommandState = ceilingCommand.init();
  let commit: ((q: Project) => Project) | undefined;
  for (const input of inputs) {
    const [ns, res] = ceilingCommand.onInput(state, input, ctx);
    state = ns;
    commit = res.commit ?? commit;
  }
  return commit ? commit(p) : p;
}

const pts = (): CmdInput[] => outline.map((point) => ({ kind: "point", point }));
const close: CmdInput = { kind: "option", id: "close" };
const pos: CmdInput = { kind: "option", id: "pos" };

describe("ceilingCommand Lage [285]", () => {
  it("Vorgabe „oben“: Oberkante am Geschoss (kein top)", () => {
    const q = run([...pts(), close]);
    expect(q.ceilings).toHaveLength(1);
    expect(q.ceilings![0].top).toBeUndefined();
  });

  it("„unter dem Geschoss“ (Bodenplatte): Oberkante auf dem Geschossboden", () => {
    const q = run([pos, ...pts(), close]);
    expect(q.ceilings![0].top).toEqual({ mode: "floor", floorId: "eg", offset: 0 });
  });

  it("„frei“: nach dem Umriss die Oberkante tippen (−0.02 = abgesenkte Balkonplatte)", () => {
    const q = run([pos, pos, ...pts(), close, { kind: "number", value: -0.02 }]);
    expect(q.ceilings).toHaveLength(1);
    expect(q.ceilings![0].top).toEqual({ mode: "floor", floorId: "eg", offset: -0.02 });
  });

  it("„frei“ ohne Eingabe: nichts angelegt; Enter nimmt 0", () => {
    expect(run([pos, pos, ...pts(), close]).ceilings ?? []).toHaveLength(0);
    const p = project();
    const ctx = ctxOf(p);
    let state: CommandState = ceilingCommand.init();
    for (const input of [pos, pos, ...pts(), close]) state = ceilingCommand.onInput(state, input, ctx)[0];
    const [, res] = ceilingCommand.onConfirm(state, ctx);
    expect(res.commit!(p).ceilings![0].top).toEqual({ mode: "floor", floorId: "eg", offset: 0 });
  });
});
