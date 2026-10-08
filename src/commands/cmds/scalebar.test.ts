/**
 * `scalebarCommand` — ein Klick → `shape:"scalebar"` mit den aktuellen
 * Segmentlänge-/Anzahl-Optionen (persistieren über Aufrufe hinweg, wie
 * `lastSides` bei `polygon.ts`).
 */

import { describe, it, expect } from "vitest";
import { scalebarCommand } from "./scalebar";
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

/** Treibt die „length"-Option auf den Ziel-Wert (Modul-Singleton, s. Polygon-Tests). */
function setLength(state: CommandState, ctx: CommandContext, target: number): CommandState {
  let s = state;
  let opts = scalebarCommand.options(s);
  while (opts.find((o) => o.id === "length")?.value !== `${target}m`) {
    [s] = scalebarCommand.onInput(s, { kind: "option", id: "length" }, ctx);
    opts = scalebarCommand.options(s);
  }
  return s;
}

/** Treibt die „segments"-Option auf den Ziel-Wert. */
function setSegments(state: CommandState, ctx: CommandContext, target: number): CommandState {
  let s = state;
  let opts = scalebarCommand.options(s);
  while (opts.find((o) => o.id === "segments")?.value !== String(target)) {
    [s] = scalebarCommand.onInput(s, { kind: "option", id: "segments" }, ctx);
    opts = scalebarCommand.options(s);
  }
  return s;
}

describe("scalebarCommand", () => {
  it("ein Klick committet shape:'scalebar' mit den aktuellen Optionen", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setLength(scalebarCommand.init(), ctx, 2);
    state = setSegments(state, ctx, 4);
    const [, result] = scalebarCommand.onInput(state, { kind: "point", point: { x: 1, y: 2 } }, ctx);
    expect(result.done).toBe(true);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("scalebar");
    if (g.shape === "scalebar") {
      expect(g.at).toEqual({ x: 1, y: 2 });
      expect(g.segmentLength).toBe(2);
      expect(g.segments).toBe(4);
    }
  });

  it("Segmentlänge zyklt durch die Presets und wrapt zurück", () => {
    const ctx = makeCtx(project());
    let state = setLength(scalebarCommand.init(), ctx, 0.5);
    expect(scalebarCommand.options(state).find((o) => o.id === "length")?.value).toBe("0.5m");
    state = setLength(state, ctx, 50);
    expect(scalebarCommand.options(state).find((o) => o.id === "length")?.value).toBe("50m");
    state = setLength(state, ctx, 0.5); // wrapt weiter zurück zum Anfang
    expect(scalebarCommand.options(state).find((o) => o.id === "length")?.value).toBe("0.5m");
  });

  it("Segmentanzahl zyklt zwischen 2 und 8", () => {
    const ctx = makeCtx(project());
    let state = setSegments(scalebarCommand.init(), ctx, 2);
    expect(scalebarCommand.options(state).find((o) => o.id === "segments")?.value).toBe("2");
    state = setSegments(state, ctx, 8);
    expect(scalebarCommand.options(state).find((o) => o.id === "segments")?.value).toBe("8");
  });

  it("onConfirm/onCancel kehren in den Ruhezustand zurück (kein Commit)", () => {
    const ctx = makeCtx(project());
    const [, res1] = scalebarCommand.onConfirm(scalebarCommand.init(), ctx);
    expect(res1.commit).toBeUndefined();
    expect(res1.done).toBe(true);
    const [, res2] = scalebarCommand.onCancel(scalebarCommand.init());
    expect(res2.commit).toBeUndefined();
    expect(res2.done).toBe(true);
  });
});
