/**
 * `bezierCommand` — manuelles Kontrollpunkt-Werkzeug: Anker → Griff 1 →
 * Griff 2 → Endpunkt je Segment, „Fertig" committet als `shape:"bezier"`.
 */

import { describe, it, expect } from "vitest";
import { bezierCommand } from "./bezier";
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

describe("bezierCommand", () => {
  it("ein Segment (4 Klicks) + Fertig → shape:bezier mit 4 Kontrollpunkten", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = bezierCommand.onInput(bezierCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = bezierCommand.onInput(state, { kind: "point", point: { x: 1, y: 3 } }, ctx);
    [state] = bezierCommand.onInput(state, { kind: "point", point: { x: 3, y: 3 } }, ctx);
    [state] = bezierCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    const [, result] = bezierCommand.onConfirm(state, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("bezier");
    if (g.shape === "bezier") {
      expect(g.pts).toEqual([
        { x: 0, y: 0 },
        { x: 1, y: 3 },
        { x: 3, y: 3 },
        { x: 4, y: 0 },
      ]);
    }
  });

  it("zwei Segmente hängen am gemeinsamen Anker (7 Punkte)", () => {
    const p = project();
    const ctx = makeCtx(p);
    const clicks = [
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 0 },
      { x: 4, y: -1 }, { x: 5, y: -1 }, { x: 6, y: 0 },
    ];
    let [state] = bezierCommand.onInput(bezierCommand.init(), { kind: "point", point: clicks[0] }, ctx);
    for (let i = 1; i < clicks.length; i++) {
      [state] = bezierCommand.onInput(state, { kind: "point", point: clicks[i] }, ctx);
    }
    const [, result] = bezierCommand.onInput(state, { kind: "option", id: "finish" }, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("bezier");
    if (g.shape === "bezier") expect(g.pts).toEqual(clicks);
  });

  it("weniger als ein volles Segment: Enter bricht ohne commit ab", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = bezierCommand.onInput(bezierCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = bezierCommand.onInput(state, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    const [, result] = bezierCommand.onConfirm(state, ctx);
    expect(result.commit).toBeUndefined();
  });
});
