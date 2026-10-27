/**
 * `circleCommand` — drei Konstruktionsmethoden: Mittelpunkt+Radius (Default,
 * unverändert), NEU 2-Punkt (Durchmesser-Enden) und 3-Punkt (Umkreis),
 * Nutzer-Wunsch „Kreis durch zwei/drei bekannte Punkte".
 */

import { describe, it, expect } from "vitest";
import { circleCommand } from "./circle";
import type { CommandContext, CommandState, Project, Vec2 } from "../types";
import type { Drawing2D } from "../../model/types";

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

const pt = (x: number, y: number) => ({ x, y });

function lineDraw(id: string, a: Vec2, b: Vec2): Drawing2D {
  return { id, type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a, b } };
}
function circleDraw(id: string, center: Vec2, r: number): Drawing2D {
  return { id, type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "circle", center, r } };
}
/** Zyklt die Methode-Option, bis `options[0].value === target` erreicht ist. */
function switchTo(state: CommandState, ctx: CommandContext, target: string): CommandState {
  let s = state;
  while (circleCommand.options(s)[0].value !== target) {
    [s] = circleCommand.onInput(s, { kind: "option", id: "method" }, ctx);
  }
  return s;
}

describe("circleCommand — Methode Mittelpunkt (Default, unverändert)", () => {
  it("Mittelpunkt → Radius-Punkt committet den Kreis", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = circleCommand.init();
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx);
    const [, result] = circleCommand.onInput(state, { kind: "point", point: pt(5, 0) }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("circle");
    if (g.shape === "circle") {
      expect(g.center).toEqual({ x: 0, y: 0 });
      expect(g.r).toBeCloseTo(5, 9);
    }
  });

  it("Mittelpunkt → getippte Zahl (Radius) committet ebenso", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = circleCommand.init();
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx);
    const [, result] = circleCommand.onInput(state, { kind: "number", value: 3 }, ctx);
    const g = result.commit!(p).drawings2d[0].geom;
    if (g.shape === "circle") expect(g.r).toBeCloseTo(3, 9);
  });
});

describe("circleCommand — Methode 2-Punkt (Durchmesser)", () => {
  it("zwei Punkte sind die Enden eines Durchmessers", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = circleCommand.init();
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx); // → 2pt
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx);
    const [, result] = circleCommand.onInput(state, { kind: "point", point: pt(4, 0) }, ctx);
    const g = result.commit!(p).drawings2d[0].geom;
    expect(g.shape).toBe("circle");
    if (g.shape === "circle") {
      expect(g.center).toEqual({ x: 2, y: 0 });
      expect(g.r).toBeCloseTo(2, 9);
    }
  });
});

describe("circleCommand — Methode 3-Punkt (Umkreis)", () => {
  it("drei Punkte auf dem Kreis ergeben den korrekten Umkreis", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = circleCommand.init();
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx);
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx); // → 3pt
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(1, 0) }, ctx);
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(0, 1) }, ctx);
    const [, result] = circleCommand.onInput(state, { kind: "point", point: pt(-1, 0) }, ctx);
    const g = result.commit!(p).drawings2d[0].geom;
    expect(g.shape).toBe("circle");
    if (g.shape === "circle") {
      expect(g.center.x).toBeCloseTo(0, 6);
      expect(g.center.y).toBeCloseTo(0, 6);
      expect(g.r).toBeCloseTo(1, 6);
    }
  });

  it("kollinearer dritter Punkt wird ignoriert (kein Commit, bleibt in Phase 3)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = circleCommand.init();
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx);
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx);
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx);
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(2, 0) }, ctx);
    const [, result] = circleCommand.onInput(state, { kind: "point", point: pt(5, 0) }, ctx);
    expect(result.commit).toBeUndefined();
  });
});

describe("circleCommand — Methodenwechsel", () => {
  it("zyklt center → 2pt → 3pt → ttr → center", () => {
    let state: CommandState = circleCommand.init();
    const p = project();
    const ctx = makeCtx(p);
    expect(circleCommand.options(state)[0].value).toBe("center");
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx);
    expect(circleCommand.options(state)[0].value).toBe("2pt");
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx);
    expect(circleCommand.options(state)[0].value).toBe("3pt");
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx);
    expect(circleCommand.options(state)[0].value).toBe("ttr");
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx);
    expect(circleCommand.options(state)[0].value).toBe("center");
  });

  it("Methodenwechsel verwirft eine laufende Konstruktion", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = circleCommand.init();
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx); // → 2pt
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx); // erster Punkt gesetzt
    [state] = circleCommand.onInput(state, { kind: "option", id: "method" }, ctx); // → 3pt, verwirft
    expect(circleCommand.prompt(state)).toBe("cmd.circle.threeFirst");
  });
});

describe("circleCommand — Methode TTR (Tangente-Tangente-Radius)", () => {
  it("Radius per getippter Zahl (2) → Kreis bei (2,2), tangential an beide Achsen-Segmente", () => {
    const p = project();
    p.drawings2d = [lineDraw("l1", pt(-10, 0), pt(10, 0)), lineDraw("l2", pt(0, -10), pt(0, 10))];
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(circleCommand.init(), ctx, "ttr");
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(5, 0) }, ctx); // near1 auf l1
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(0, 5) }, ctx); // near2 auf l2
    const [, result] = circleCommand.onInput(state, { kind: "number", value: 2 }, ctx);
    expect(result.commit).toBeDefined();
    const g = result.commit!(p).drawings2d.at(-1)!.geom;
    expect(g.shape).toBe("circle");
    if (g.shape === "circle") {
      expect(g.center.x).toBeCloseTo(2, 9);
      expect(g.center.y).toBeCloseTo(2, 9);
      expect(g.r).toBeCloseTo(2, 9);
    }
  });

  it("Radius per Klickpunkt (Abstand zum ERSTEN Klickpunkt) → derselbe Kreis wie bei getippter Zahl", () => {
    const p = project();
    p.drawings2d = [lineDraw("l1", pt(-10, 0), pt(10, 0)), lineDraw("l2", pt(0, -10), pt(0, 10))];
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(circleCommand.init(), ctx, "ttr");
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(5, 0) }, ctx); // near1=(5,0)
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(0, 5) }, ctx); // near2=(0,5)
    // Klickpunkt (7,0): Abstand zu near1(5,0) ist genau 2 → identischer Radius wie oben.
    const [, result] = circleCommand.onInput(state, { kind: "point", point: pt(7, 0) }, ctx);
    expect(result.commit).toBeDefined();
    const g = result.commit!(p).drawings2d.at(-1)!.geom;
    if (g.shape === "circle") {
      expect(g.center.x).toBeCloseTo(2, 9);
      expect(g.center.y).toBeCloseTo(2, 9);
      expect(g.r).toBeCloseTo(2, 9);
    }
  });

  it("Linie + Kreis: Zielkreis in der Lücke, tangential an beide", () => {
    const p = project();
    p.drawings2d = [lineDraw("l1", pt(-10, 0), pt(10, 0)), circleDraw("c1", pt(0, 6), 3)];
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(circleCommand.init(), ctx, "ttr");
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(3, 0) }, ctx); // near1 auf der Linie
    // near2 auf dem Kreis, nahe dem erwarteten Kandidaten (3,2): Punkt auf dem
    // Kreis in Richtung (3,-4) von (0,6) aus, normiert*3 = (1.8, 3.6).
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(1.8, 3.6) }, ctx);
    const [, result] = circleCommand.onInput(state, { kind: "number", value: 2 }, ctx);
    expect(result.commit).toBeDefined();
    const g = result.commit!(p).drawings2d.at(-1)!.geom;
    if (g.shape === "circle") {
      expect(g.center.x).toBeCloseTo(3, 6);
      expect(g.center.y).toBeCloseTo(2, 6);
      expect(g.r).toBeCloseTo(2, 9);
    }
  });

  it("Klick trifft keine Linie/Kreis → wird ignoriert, Schritt bleibt in Phase 1", () => {
    const p = project();
    p.drawings2d = [lineDraw("l1", pt(-10, 0), pt(10, 0))];
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(circleCommand.init(), ctx, "ttr");
    const [ns, result] = circleCommand.onInput(state, { kind: "point", point: pt(100, 100) }, ctx);
    expect(result.commit).toBeUndefined();
    expect(circleCommand.prompt(ns)).toBe("cmd.circle.ttrFirst");
  });

  it("zweiter Klick trifft dasselbe Element wie der erste → wird ignoriert, Schritt bleibt in Phase 2", () => {
    const p = project();
    p.drawings2d = [lineDraw("l1", pt(-10, 0), pt(10, 0))];
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(circleCommand.init(), ctx, "ttr");
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(5, 0) }, ctx); // trifft l1
    const [ns, result] = circleCommand.onInput(state, { kind: "point", point: pt(-5, 0) }, ctx); // trifft l1 nochmal
    expect(result.commit).toBeUndefined();
    expect(circleCommand.prompt(ns)).toBe("cmd.circle.ttrSecond");
  });

  it("geometrisch unlösbarer Radius (z. B. 0) → kein Commit, Schritt bleibt in Phase 3", () => {
    const p = project();
    p.drawings2d = [lineDraw("l1", pt(-10, 0), pt(10, 0)), lineDraw("l2", pt(0, -10), pt(0, 10))];
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(circleCommand.init(), ctx, "ttr");
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(5, 0) }, ctx);
    [state] = circleCommand.onInput(state, { kind: "point", point: pt(0, 5) }, ctx);
    const [, result] = circleCommand.onInput(state, { kind: "number", value: 0 }, ctx);
    expect(result.commit).toBeUndefined();
  });
});
