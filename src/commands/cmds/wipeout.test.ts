/**
 * `wipeoutCommand` — Punktfolge (wie `polyline`) → geschlossene weisse
 * `polyline` (Maskenregion). Anders als `revcloud`/`polyline` gibt es KEINEN
 * offenen Endzustand: sowohl Klick-nahe-Start als auch Enter schliessen.
 */

import { describe, it, expect } from "vitest";
import { wipeoutCommand } from "./wipeout";
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

describe("wipeoutCommand", () => {
  it("Klick nahe Startpunkt (≥3 Punkte) schliesst und committet weiss gefüllt", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = wipeoutCommand.init();
    [state] = wipeoutCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = wipeoutCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    [state] = wipeoutCommand.onInput(state, { kind: "point", point: { x: 4, y: 4 } }, ctx);
    const [, result] = wipeoutCommand.onInput(state, { kind: "point", point: { x: 0.05, y: 0.02 } }, ctx);
    expect(result.done).toBe(true);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const d = next.drawings2d[0];
    expect(d.geom.shape).toBe("polyline");
    if (d.geom.shape === "polyline") {
      expect(d.geom.closed).toBe(true);
      expect(d.geom.pts).toEqual([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
      ]);
    }
    expect(d.background).toBe("#ffffff");
    expect(d.color).toBe("#ffffff");
  });

  it("Enter (≥3 Punkte) schliesst AUTOMATISCH statt offen zu bleiben", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = wipeoutCommand.init();
    [state] = wipeoutCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = wipeoutCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    [state] = wipeoutCommand.onInput(state, { kind: "point", point: { x: 4, y: 4 } }, ctx);
    const [, result] = wipeoutCommand.onConfirm(state, ctx);
    expect(result.done).toBe(true);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape === "polyline") expect(g.closed).toBe(true);
  });

  it("Enter mit nur 2 Punkten committet NICHTS (kein sinnvoller offener Endzustand)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = wipeoutCommand.init();
    [state] = wipeoutCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = wipeoutCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    const [, result] = wipeoutCommand.onConfirm(state, ctx);
    expect(result.commit).toBeUndefined();
    expect(result.done).toBe(true);
  });

  it("onCancel kehrt in den Ruhezustand zurück (kein Commit)", () => {
    const [, res] = wipeoutCommand.onCancel(wipeoutCommand.init());
    expect(res.commit).toBeUndefined();
    expect(res.done).toBe(true);
  });
});
