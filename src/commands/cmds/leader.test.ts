/**
 * `leaderCommand` — Zielpunkt + Textanker → leeres `text`-Element mit
 * `leaderTarget` gesetzt, meldet `focusDrawingId` (öffnet den Inline-Editor).
 * Nutzer-Wunsch „kein Knick-Punkt wie bei AutoCADs Multileader": optionale
 * Knickpunkte über die Option „bends" (Default 0 = unverändertes Verhalten).
 */

import { describe, it, expect } from "vitest";
import { leaderCommand } from "./leader";
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

describe("leaderCommand", () => {
  it("Zielpunkt + Anker → leeres Text-Element mit leaderTarget, focusDrawingId gesetzt", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterTarget] = leaderCommand.onInput(
      leaderCommand.init(),
      { kind: "point", point: { x: 10, y: 10 } },
      ctx,
    );
    const [, result] = leaderCommand.onInput(
      afterTarget,
      { kind: "point", point: { x: 2, y: 2 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    expect(result.focusDrawingId).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.text).toBe("");
      expect(g.at).toEqual({ x: 2, y: 2 });
      expect(g.leaderTarget).toEqual({ x: 10, y: 10 });
    }
    expect(next.drawings2d[0].id).toBe(result.focusDrawingId);
  });
});

/** Zyklt die "bends"-Option, bis der gewünschte Wert erreicht ist (unabhängig
 *  vom aktuellen Stand — Option ist ein persistentes Modul-Singleton, s.
 *  `lastBendCount`, dasselbe Muster wie `lastCount` bei Array). */
function setBends(state: CommandState, ctx: CommandContext, target: number): CommandState {
  let s = state;
  for (let i = 0; i <= 4; i++) {
    if (leaderCommand.options(s)[0].value === String(target)) return s;
    [s] = leaderCommand.onInput(s, { kind: "option", id: "bends" }, ctx);
  }
  return s;
}

describe("leaderCommand — Knickpunkte (Multileader-Stil)", () => {
  it("Default (0 Knicke): keine leaderBendPoints im committeten Element", () => {
    const p = project();
    const ctx = makeCtx(p);
    const state = setBends(leaderCommand.init(), ctx, 0);
    const [afterTarget] = leaderCommand.onInput(state, { kind: "point", point: { x: 10, y: 10 } }, ctx);
    const [, result] = leaderCommand.onInput(afterTarget, { kind: "point", point: { x: 2, y: 2 } }, ctx);
    const g = result.commit!(p).drawings2d[0].geom;
    if (g.shape === "text") expect(g.leaderBendPoints).toBeUndefined();
  });

  it("1 Knick: Ziel → Knick → Anker committet leaderTarget UND leaderBendPoints", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setBends(leaderCommand.init(), ctx, 1);
    [state] = leaderCommand.onInput(state, { kind: "point", point: { x: 10, y: 10 } }, ctx); // Ziel
    expect(leaderCommand.prompt(state)).toBe("cmd.leader.bend");
    [state] = leaderCommand.onInput(state, { kind: "point", point: { x: 6, y: 8 } }, ctx); // Knick
    expect(leaderCommand.prompt(state)).toBe("cmd.leader.anchor");
    const [, result] = leaderCommand.onInput(state, { kind: "point", point: { x: 2, y: 2 } }, ctx); // Anker
    const g = result.commit!(p).drawings2d[0].geom;
    expect(g.shape).toBe("text");
    if (g.shape === "text") {
      expect(g.at).toEqual({ x: 2, y: 2 });
      expect(g.leaderTarget).toEqual({ x: 10, y: 10 });
      expect(g.leaderBendPoints).toEqual([{ x: 6, y: 8 }]);
    }
  });

  it("2 Knicke: beide Punkte landen in leaderBendPoints, in Klick-Reihenfolge", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setBends(leaderCommand.init(), ctx, 2);
    [state] = leaderCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx); // Ziel
    [state] = leaderCommand.onInput(state, { kind: "point", point: { x: 1, y: 1 } }, ctx); // Knick 1
    [state] = leaderCommand.onInput(state, { kind: "point", point: { x: 2, y: 1 } }, ctx); // Knick 2
    const [, result] = leaderCommand.onInput(state, { kind: "point", point: { x: 3, y: 0 } }, ctx); // Anker
    const g = result.commit!(p).drawings2d[0].geom;
    if (g.shape === "text") {
      expect(g.leaderBendPoints).toEqual([{ x: 1, y: 1 }, { x: 2, y: 1 }]);
    }
  });
});
