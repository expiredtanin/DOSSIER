/**
 * [285] `wallCommand` — Option „Wandtyp“ (reihum durch die Typen des Projekts) und „Aussenbauteil“ (IFC `IsExternal`):
 * Vorgabe nach dem Namen des Wandtyps („Aussenwand“ ⇒ aussen, „Innenwand“ ⇒ innen), ausdrücklich umschaltbar.
 */
import { describe, expect, it } from "vitest";
import { wallCommand } from "./wall";
import type { CommandContext, CmdInput, CommandState, Project } from "../types";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [
      { id: "aw", name: "Aussenwand 36", layers: [{ componentId: "c", thickness: 0.36 }] },
      { id: "iw", name: "Innenwand 12", layers: [{ componentId: "c", thickness: 0.12 }] },
      { id: "bt", name: "Beton", layers: [{ componentId: "c", thickness: 0.2 }] },
    ],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
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

const ctxOf = (p: Project): CommandContext => ({
  project: p,
  level: p.drawingLevels[0],
  defaultCategoryCode: "20",
  activeLineStyleId: "solid",
  activeWallTypeId: "aw",
  lastPoint: null,
  selection: { wallIds: [], drawingId: null },
});

const A = { x: 0, y: 0 };
const B = { x: 4, y: 0 };

function draw(options: string[]): Project["walls"][number] {
  const p = project();
  const ctx = ctxOf(p);
  let state: CommandState = wallCommand.init();
  for (const id of options) state = wallCommand.onInput(state, { kind: "option", id }, ctx)[0];
  for (const point of [A, B]) state = wallCommand.onInput(state, { kind: "point", point } as CmdInput, ctx)[0];
  const [, res] = wallCommand.onConfirm(state, ctx);
  return res.commit!(p).walls[0];
}

describe("wallCommand Wandtyp und Aussenbauteil [285]", () => {
  it("Vorgabe: aktiver Wandtyp „Aussenwand“ ⇒ Aussenbauteil", () => {
    const w = draw([]);
    expect(w.wallTypeId).toBe("aw");
    expect(w.isExternal).toBe(true);
  });

  it("Option Wandtyp wählt den nächsten Typ des Projekts; „Innenwand“ ⇒ innen", () => {
    const w = draw(["wtype"]);
    expect(w.wallTypeId).toBe("iw");
    expect(w.isExternal).toBe(false);
  });

  it("Typ ohne Hinweis im Namen: keine Angabe; Option Aussenbauteil schaltet auto → ja → nein", () => {
    expect(draw(["wtype", "wtype"]).isExternal).toBeUndefined();
    expect(draw(["wtype", "wtype", "ext"]).isExternal).toBe(true);
    expect(draw(["ext", "ext"]).isExternal).toBe(false);
  });

  it("Die Optionen zeigen den gewählten Typ", () => {
    const p = project();
    const ctx = ctxOf(p);
    const [s] = wallCommand.onInput(wallCommand.init(), { kind: "option", id: "wtype" }, ctx);
    const o = wallCommand.options(s).find((x) => x.id === "wtype");
    expect(o?.value).toBe("Innenwand 12");
  });
});
