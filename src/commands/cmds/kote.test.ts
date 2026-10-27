/**
 * `koteCommand` — Punkt + getippter Höhenwert → `shape:"kote"` (SIA 400
 * B.5.4, Figur 18). Default-Art „OK fertig"; per Option zyklisch umschaltbar.
 */

import { describe, it, expect } from "vitest";
import { koteCommand } from "./kote";
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

describe("koteCommand", () => {
  it("Punkt + Zahl → shape:kote mit Default-Art OK fertig, rotation 0", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = koteCommand.onInput(koteCommand.init(), { kind: "point", point: { x: 2, y: 3 } }, ctx);
    const [, result] = koteCommand.onInput(state, { kind: "number", value: 3.25 }, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("kote");
    if (g.shape === "kote") {
      expect(g.at).toEqual({ x: 2, y: 3 });
      expect(g.value).toBe(3.25);
      expect(g.kind).toBe("okFertig");
      expect(g.rotation).toBe(0);
    }
  });

  it("Art-Option zyklt OK fertig → UK fertig → OK roh → UK roh → OK fertig", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = koteCommand.onInput(koteCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      [state] = koteCommand.onInput(state, { kind: "option", id: "kind" }, ctx);
      const opts = koteCommand.options(state);
      seen.push(opts[0].value!);
    }
    expect(seen).toEqual(["ukFertig", "okRoh", "ukRoh", "okFertig"]);
  });

  it("negativer Wert wird unverändert übernommen (Formatierung passiert erst beim Rendern)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = koteCommand.onInput(koteCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [, result] = koteCommand.onInput(state, { kind: "number", value: -0.1 }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "kote") expect(g.value).toBe(-0.1);
  });
});
