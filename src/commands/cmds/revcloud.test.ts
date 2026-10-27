/**
 * `revcloudCommand` — Punktfolge (wie `polyline`) → geschlossene/offene
 * `polyline` mit Beulen-`bulge` (Revisionswolke).
 */

import { describe, it, expect } from "vitest";
import { revcloudCommand } from "./revcloud";
import type { CommandContext, CommandState, Project } from "../types";

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

/** Treibt die „arcSize"-Option auf den Ziel-Wert (Modul-Singleton, s. Polygon-Tests). */
function setArcSize(state: CommandState, ctx: CommandContext, target: number): CommandState {
  let s = state;
  let opts = revcloudCommand.options(s);
  while (opts.find((o) => o.id === "arcSize")?.value !== `${target}m`) {
    [s] = revcloudCommand.onInput(s, { kind: "option", id: "arcSize" }, ctx);
    opts = revcloudCommand.options(s);
  }
  return s;
}

describe("revcloudCommand", () => {
  it("Enter nach ≥2 Punkten committet eine OFFENE Polylinie mit bulge", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setArcSize(revcloudCommand.init(), ctx, 0.5);
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 3, y: 0 } }, ctx);
    const [, result] = revcloudCommand.onConfirm(state, ctx);
    expect(result.done).toBe(true);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape === "polyline") {
      expect(g.closed).toBe(false);
      expect(g.bulge?.length).toBeGreaterThan(0);
      expect(g.bulge?.every((b) => Math.abs(b) > 1e-9)).toBe(true);
      // Start-/Endpunkt der expandierten Kontur bleiben die Original-Klicks.
      expect(g.pts[0]).toEqual({ x: 0, y: 0 });
      expect(g.pts[g.pts.length - 1]).toEqual({ x: 3, y: 0 });
    }
  });

  it("Klick nahe dem Startpunkt (≥3 Punkte) committet als GESCHLOSSENEN Ring", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setArcSize(revcloudCommand.init(), ctx, 0.5);
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 4, y: 4 } }, ctx);
    const [, result] = revcloudCommand.onInput(state, { kind: "point", point: { x: 0.05, y: 0.02 } }, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "polyline") {
      expect(g.closed).toBe(true);
    }
  });

  it("die explizite 'Schliessen'-Option committet ebenfalls als Ring", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setArcSize(revcloudCommand.init(), ctx, 0.5);
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 4, y: 4 } }, ctx);
    expect(revcloudCommand.options(state).some((o) => o.id === "close")).toBe(true);
    const [, result] = revcloudCommand.onInput(state, { kind: "option", id: "close" }, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "polyline") expect(g.closed).toBe(true);
  });

  it("'Schliessen'-Option ist erst ab 3 Punkten verfügbar", () => {
    const ctx = makeCtx(project());
    let state = revcloudCommand.init() as CommandState;
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    expect(revcloudCommand.options(state).some((o) => o.id === "close")).toBe(false);
  });

  it("Beulengrösse zyklt durch die Presets", () => {
    const ctx = makeCtx(project());
    let state = setArcSize(revcloudCommand.init(), ctx, 0.2);
    expect(revcloudCommand.options(state).find((o) => o.id === "arcSize")?.value).toBe("0.2m");
    state = setArcSize(state, ctx, 1.2);
    expect(revcloudCommand.options(state).find((o) => o.id === "arcSize")?.value).toBe("1.2m");
  });

  it("Enter mit nur 1 Punkt committet nichts (kehrt in den Ruhezustand zurück)", () => {
    const ctx = makeCtx(project());
    let state = revcloudCommand.init() as CommandState;
    [state] = revcloudCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [after, result] = revcloudCommand.onConfirm(state, ctx);
    expect(result.commit).toBeUndefined();
    expect(result.done).toBe(true);
    expect((after as { phase: string }).phase).toBe("start");
  });

  it("onCancel kehrt in den Ruhezustand zurück", () => {
    const [, res] = revcloudCommand.onCancel(revcloudCommand.init());
    expect(res.done).toBe(true);
    expect(res.commit).toBeUndefined();
  });
});
