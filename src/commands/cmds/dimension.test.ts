/**
 * `dimensionCommand` — zwei Punkte + Lage der Masslinie → `shape:"dimension"`.
 * Die Masszahl wird NICHT gespeichert (aus dist(a,b) beim Rendern abgeleitet).
 */

import { describe, it, expect } from "vitest";
import { dimensionCommand } from "./dimension";
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
    doors: [],
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

describe("dimensionCommand", () => {
  it("zwei Punkte + Offset-Klick (links positiv) → shape:dimension mit korrektem Vorzeichen", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 10, y: 0 } }, ctx);
    // Cursor bei y=2 (oberhalb von a→b, entlang +x) → Links-Normale zeigt nach +y.
    const [, result] = dimensionCommand.onInput(state, { kind: "point", point: { x: 5, y: 2 } }, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("dimension");
    if (g.shape === "dimension") {
      expect(g.a).toEqual({ x: 0, y: 0 });
      expect(g.b).toEqual({ x: 10, y: 0 });
      expect(g.offset).toBeCloseTo(2, 6);
    }
  });

  it("getippte Offset-Zahl committet direkt (kein Punkt-Klick nötig)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 0, y: 5 } }, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 1.5 }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "dimension") expect(g.offset).toBe(1.5);
  });

  it("Null-Strecke (a===b) committet nichts", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 3, y: 3 } },
      ctx,
    );
    const [, result] = dimensionCommand.onInput(state, { kind: "point", point: { x: 3, y: 3 } }, ctx);
    expect(result.commit).toBeUndefined();
    expect(result.done).toBe(true);
  });
});
