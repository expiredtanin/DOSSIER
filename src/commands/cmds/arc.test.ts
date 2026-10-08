/**
 * `arcCommand` — zwei Konstruktionsmethoden: Mittelpunkt+Start+Ende (Default,
 * unverändert) und NEU 3-Punkt (Start+Durchgangspunkt+Ende), Nutzer-Wunsch
 * „Architekten kennen fast nie den Bogen-Mittelpunkt".
 */

import { describe, it, expect } from "vitest";
import { arcCommand } from "./arc";
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

const pt = (x: number, y: number) => ({ x, y });

describe("arcCommand — Methode Mittelpunkt (Default, unverändert)", () => {
  it("Mittelpunkt → Startpunkt (Radius+a0) → Endpunkt (a1) committet den Bogen", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = arcCommand.init();
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx); // center
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(1, 0) }, ctx); // start (r=1, a0=0)
    const [, result] = arcCommand.onInput(state, { kind: "point", point: pt(0, 1) }, ctx); // end (a1=90°)
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d).toHaveLength(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("arc");
    if (g.shape === "arc") {
      expect(g.center).toEqual({ x: 0, y: 0 });
      expect(g.r).toBeCloseTo(1, 9);
      expect(g.a0).toBeCloseTo(0, 9);
      expect(g.a1).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it("Default-Methode ist \"center\" ohne Options-Umschalten", () => {
    expect(arcCommand.options(arcCommand.init())[0].value).toBe("center");
  });
});

describe("arcCommand — Methode 3-Punkt", () => {
  it("Options-Umschalten (\"m\") wechselt von \"center\" auf \"3pt\" (voller Zyklus s. eigener Test unten)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = arcCommand.init();
    expect(arcCommand.options(state)[0].value).toBe("center");
    [state] = arcCommand.onInput(state, { kind: "option", id: "method" }, ctx);
    expect(arcCommand.options(state)[0].value).toBe("3pt");
  });

  it("Start → Durchgangspunkt → Ende committet einen Bogen durch alle drei Punkte", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = arcCommand.init();
    [state] = arcCommand.onInput(state, { kind: "option", id: "method" }, ctx); // → 3pt
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(1, 0) }, ctx); // Start
    [state] = arcCommand.onInput(
      state,
      { kind: "point", point: pt(Math.SQRT1_2, Math.SQRT1_2) }, // Durchgangspunkt (45°)
      ctx,
    );
    const [, result] = arcCommand.onInput(state, { kind: "point", point: pt(0, 1) }, ctx); // Ende
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d).toHaveLength(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("arc");
    if (g.shape === "arc") {
      expect(g.center.x).toBeCloseTo(0, 6);
      expect(g.center.y).toBeCloseTo(0, 6);
      expect(g.r).toBeCloseTo(1, 6);
      expect(g.a0).toBeCloseTo(0, 6);
      expect(g.a1).toBeCloseTo(Math.PI / 2, 6);
    }
  });

  it("kollinearer Endpunkt-Versuch committet nichts (bleibt in Phase 3, wartet auf einen gültigen Punkt)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = arcCommand.init();
    [state] = arcCommand.onInput(state, { kind: "option", id: "method" }, ctx);
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx);
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(2, 0) }, ctx); // Durchgangspunkt auf der Geraden
    const [, result] = arcCommand.onInput(state, { kind: "point", point: pt(5, 0) }, ctx); // Ende ebenfalls kollinear
    expect(result.commit).toBeUndefined();
    expect(result.done).toBeUndefined();
  });

  it("Methodenwechsel verwirft eine laufende Konstruktion (kein halbfertiger Bogen)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = arcCommand.init();
    [state] = arcCommand.onInput(state, { kind: "option", id: "method" }, ctx); // → 3pt
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx); // Start gesetzt
    [state] = arcCommand.onInput(state, { kind: "option", id: "method" }, ctx); // weiter → radius
    // Nach dem Wechsel muss der Befehl wieder ganz am Anfang der NEUEN Methode
    // stehen (kein übernommener Start-Punkt aus der vorherigen Konstruktion).
    expect(arcCommand.prompt(state)).toBe("cmd.arc.serStart");
  });
});

/** Wechselt zyklisch auf die Ziel-Methode ("m" so oft wie nötig). */
function switchTo(state: CommandState, ctx: CommandContext, target: string): CommandState {
  let s = state;
  while (arcCommand.options(s)[0].value !== target) {
    [s] = arcCommand.onInput(s, { kind: "option", id: "method" }, ctx);
  }
  return s;
}

describe("arcCommand — Methode Start-Ende-Radius (\"ser\")", () => {
  it("Options-Zyklus deckt center→3pt→radius→direction→center ab", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = arcCommand.init();
    const seen: string[] = [arcCommand.options(state)[0].value!];
    for (let i = 0; i < 4; i++) {
      [state] = arcCommand.onInput(state, { kind: "option", id: "method" }, ctx);
      seen.push(arcCommand.options(state)[0].value!);
    }
    expect(seen).toEqual(["center", "3pt", "radius", "direction", "center"]);
  });

  it("Start → Ende → Radius-Punkt committet den KLEINEREN Bogen zur Cursor-Seite", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(arcCommand.init(), ctx, "radius");
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx); // Start
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(4, 0) }, ctx); // Ende
    const [, result] = arcCommand.onInput(state, { kind: "point", point: pt(2, 5) }, ctx); // Radius-Punkt oberhalb
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("arc");
    if (g.shape === "arc") {
      expect(Math.hypot(0 - g.center.x, 0 - g.center.y)).toBeCloseTo(g.r, 6);
      expect(Math.hypot(4 - g.center.x, 0 - g.center.y)).toBeCloseTo(g.r, 6);
      expect(g.center.y).toBeLessThan(0); // Zentrum unterhalb → Bogen wölbt sich nach oben
    }
  });

  it("getippter Radius nutzt den zuletzt bekannten Cursor als Seiten-Referenz", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(arcCommand.init(), ctx, "radius");
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx);
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(4, 0) }, ctx);
    [state] = arcCommand.onMove(state, pt(2, -5), null, ctx);
    const [, result] = arcCommand.onInput(state, { kind: "number", value: 3 }, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "arc") {
      expect(g.r).toBeCloseTo(3, 6);
      expect(g.center.y).toBeGreaterThan(0); // Cursor war unterhalb → Zentrum oberhalb
    }
  });

  it("Radius kleiner als die halbe Sehnenlänge committet nichts (bleibt aktiv)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(arcCommand.init(), ctx, "radius");
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(0, 0) }, ctx);
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(4, 0) }, ctx);
    const [, result] = arcCommand.onInput(state, { kind: "point", point: pt(2, 0.1) }, ctx); // r≈0.1 < 2
    expect(result.commit).toBeUndefined();
  });
});

describe("arcCommand — Methode Start-Ende-Richtung (\"sed\")", () => {
  it("Start → Ende → Richtungspunkt committet einen Bogen tangential zur Richtung bei Start", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(arcCommand.init(), ctx, "direction");
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(1, 0) }, ctx); // Start
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(0, 1) }, ctx); // Ende
    const [, result] = arcCommand.onInput(state, { kind: "point", point: pt(1, 1) }, ctx); // Richtung +y bei Start
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("arc");
    if (g.shape === "arc") {
      expect(g.center.x).toBeCloseTo(0, 6);
      expect(g.center.y).toBeCloseTo(0, 6);
      expect(g.r).toBeCloseTo(1, 6);
    }
  });

  it("entartete Richtung (Klick auf den Startpunkt) committet nichts (bleibt aktiv)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state: CommandState = switchTo(arcCommand.init(), ctx, "direction");
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(1, 0) }, ctx);
    [state] = arcCommand.onInput(state, { kind: "point", point: pt(0, 1) }, ctx);
    const [, result] = arcCommand.onInput(state, { kind: "point", point: pt(1, 0) }, ctx); // = Start
    expect(result.commit).toBeUndefined();
  });
});
