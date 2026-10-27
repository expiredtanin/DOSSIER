/**
 * `splineCommand` — Wegpunkte klicken (wie polyline), Enter/„Schliessen"
 * committet als `shape:"spline"` mit den ROHEN Wegpunkten (Tessellierung
 * passiert erst beim Rendern/Snapping, s. `tools/curves.ts`).
 */

import { describe, it, expect } from "vitest";
import { splineCommand } from "./spline";
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

describe("splineCommand", () => {
  it("drei Punkte + Enter → offene Spline mit den drei Wegpunkten", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = splineCommand.onInput(splineCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = splineCommand.onInput(state, { kind: "point", point: { x: 2, y: 3 } }, ctx);
    [state] = splineCommand.onInput(state, { kind: "point", point: { x: 5, y: 1 } }, ctx);
    const [, result] = splineCommand.onConfirm(state, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("spline");
    if (g.shape === "spline") {
      expect(g.closed).toBe(false);
      expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 5, y: 1 }]);
      expect(g.mode).toBe("fit"); // Default, unverändert.
    }
  });

  it("Schliessen-Option committet als Ring (closed: true)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = splineCommand.onInput(splineCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = splineCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    [state] = splineCommand.onInput(state, { kind: "point", point: { x: 4, y: 4 } }, ctx);
    const [, result] = splineCommand.onInput(state, { kind: "option", id: "close" }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("spline");
    if (g.shape === "spline") expect(g.closed).toBe(true);
  });
});

describe("splineCommand — Kurven-Modus (fit/control)", () => {
  it("Default-Option-Wert ist 'fit'", () => {
    const state = splineCommand.init();
    const opt = splineCommand.options(state).find((o) => o.id === "curveMode");
    expect(opt?.value).toBe("fit");
  });

  it("Option 'curveMode' zyklt fit → cv → fit", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = splineCommand.onInput(splineCommand.init(), { kind: "option", id: "curveMode" }, ctx);
    expect(splineCommand.options(state).find((o) => o.id === "curveMode")?.value).toBe("cv");
    [state] = splineCommand.onInput(state, { kind: "option", id: "curveMode" }, ctx);
    expect(splineCommand.options(state).find((o) => o.id === "curveMode")?.value).toBe("fit");
  });

  it("Modus 'control' committet geom.mode:'control'", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = splineCommand.onInput(splineCommand.init(), { kind: "option", id: "curveMode" }, ctx); // → cv
    [state] = splineCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = splineCommand.onInput(state, { kind: "point", point: { x: 2, y: 5 } }, ctx);
    [state] = splineCommand.onInput(state, { kind: "point", point: { x: 6, y: 5 } }, ctx);
    const [, result] = splineCommand.onConfirm(state, ctx);
    const g = result.commit!(p).drawings2d[0].geom;
    if (g.shape === "spline") {
      expect(g.mode).toBe("control");
      expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 2, y: 5 }, { x: 6, y: 5 }]);
    }
  });

  it("Umschalten des Kurven-Modus verwirft die laufende Konstruktion NICHT (bleibt in Phase 'next', Punkte erhalten)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = splineCommand.onInput(splineCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = splineCommand.onInput(state, { kind: "point", point: { x: 2, y: 3 } }, ctx);
    [state] = splineCommand.onInput(state, { kind: "option", id: "curveMode" }, ctx); // → cv, mitten im Zug
    expect(splineCommand.prompt(state)).toBe("cmd.spline.next");
    const [, result] = splineCommand.onConfirm(state, ctx);
    const g = result.commit!(p).drawings2d[0].geom;
    if (g.shape === "spline") {
      expect(g.mode).toBe("control");
      expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 2, y: 3 }]);
    }
  });
});
