/**
 * `ellipseCommand` — zwei Konstruktionsmethoden: Box (Default, zwei
 * Bounding-Box-Ecken, rotation 0) und NEU Achse (Zentrum + Hauptachse +
 * Nebenachse, beliebig gedreht).
 */

import { describe, it, expect } from "vitest";
import { ellipseCommand } from "./ellipse";
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

describe("ellipseCommand", () => {
  it("zwei Ecken → Zentrum + Halbachsen aus der Bounding-Box, rotation 0", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterCorner1] = ellipseCommand.onInput(
      ellipseCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [, result] = ellipseCommand.onInput(
      afterCorner1,
      { kind: "point", point: { x: 8, y: 4 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("ellipse");
    if (g.shape === "ellipse") {
      expect(g.center).toEqual({ x: 4, y: 2 });
      expect(g.rx).toBeCloseTo(4, 6);
      expect(g.ry).toBeCloseTo(2, 6);
      expect(g.rotation).toBe(0);
    }
  });

  it("entartete Bbox (Punkt=Punkt) committet nichts", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterCorner1] = ellipseCommand.onInput(
      ellipseCommand.init(),
      { kind: "point", point: { x: 5, y: 5 } },
      ctx,
    );
    const [, result] = ellipseCommand.onInput(
      afterCorner1,
      { kind: "point", point: { x: 5, y: 5 } },
      ctx,
    );
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(0);
  });
});

describe("ellipseCommand — Methode Achse (gedreht)", () => {
  function toAxis(): CommandState {
    const [state] = ellipseCommand.onInput(ellipseCommand.init(), { kind: "option", id: "method" }, makeCtx(project()));
    return state;
  }

  it("Zentrum + Hauptachse (0,0)→(4,0) + Nebenachse-Punkt (0,2) → rx=4, ry=2, rotation=0", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = toAxis();
    [state] = ellipseCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx); // Zentrum
    [state] = ellipseCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx); // Hauptachse
    const [, result] = ellipseCommand.onInput(state, { kind: "point", point: { x: 0, y: 2 } }, ctx); // Nebenachse
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("ellipse");
    if (g.shape === "ellipse") {
      expect(g.center).toEqual({ x: 0, y: 0 });
      expect(g.rx).toBeCloseTo(4, 6);
      expect(g.ry).toBeCloseTo(2, 6);
      expect(g.rotation).toBeCloseTo(0, 6);
    }
  });

  it("gedrehte Hauptachse (0,0)→(0,4) (90°) + Nebenachse-Punkt → rotation=90°, ry aus senkrechtem Abstand", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = toAxis();
    [state] = ellipseCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = ellipseCommand.onInput(state, { kind: "point", point: { x: 0, y: 4 } }, ctx); // Achse nach oben (90°)
    const [, result] = ellipseCommand.onInput(state, { kind: "point", point: { x: 3, y: 0 } }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "ellipse") {
      expect(g.rx).toBeCloseTo(4, 6);
      expect(g.ry).toBeCloseTo(3, 6);
      expect(g.rotation).toBeCloseTo(Math.PI / 2, 6);
    }
  });

  it("degenerierte Hauptachse (Zentrum=Punkt) wird ignoriert, bleibt in Phase 'major'", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = toAxis();
    [state] = ellipseCommand.onInput(state, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    const [after, result] = ellipseCommand.onInput(state, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    expect(result.commit).toBeUndefined();
    expect((after as { phase: string }).phase).toBe("major");
  });

  it("Methode zyklisch: box → axis → box", () => {
    let state = ellipseCommand.init() as CommandState;
    expect(ellipseCommand.options(state)[0].value).toBe("box");
    [state] = ellipseCommand.onInput(state, { kind: "option", id: "method" }, makeCtx(project()));
    expect(ellipseCommand.options(state)[0].value).toBe("axis");
    [state] = ellipseCommand.onInput(state, { kind: "option", id: "method" }, makeCtx(project()));
    expect(ellipseCommand.options(state)[0].value).toBe("box");
  });
});
