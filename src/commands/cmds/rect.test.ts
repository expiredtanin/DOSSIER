/**
 * `rectCommand` — drei Konstruktionsmethoden (2-Punkt/3-Punkt-gedreht/
 * Zentrum, alle achsparallel-agnostisch) + NEU Eck-Radius (rein additiv,
 * gilt für alle drei Methoden, Default 0 = scharfe Ecken, byte-identisch
 * zum bisherigen Verhalten).
 */

import { describe, it, expect } from "vitest";
import { rectCommand } from "./rect";
import type { CommandContext, CommandState, Project, Vec2 } from "../types";

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

const dist = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);

/** Treibt die „radius"-Option auf den Ziel-Wert (Modul-Singleton, s. Leader/
 *  Array/Polygon-Tests für dasselbe Muster — Reihenfolge-unabhängig). */
function setRadius(state: CommandState, ctx: CommandContext, target: number): CommandState {
  let s = state;
  let opts = rectCommand.options(s);
  while (opts.find((o) => o.id === "radius")?.value !== String(target)) {
    [s] = rectCommand.onInput(s, { kind: "option", id: "radius" }, ctx);
    opts = rectCommand.options(s);
  }
  return s;
}

describe("rectCommand — 2-Punkt (Default-Methode), Radius 0", () => {
  it("zwei gegenüberliegende Ecken → shape:'rect'", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setRadius(rectCommand.init(), ctx, 0);
    [state] = rectCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [, result] = rectCommand.onInput(state, { kind: "point", point: { x: 4, y: 2 } }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("rect");
    if (g.shape === "rect") {
      expect(g.min).toEqual({ x: 0, y: 0 });
      expect(g.max).toEqual({ x: 4, y: 2 });
    }
  });
});

describe("rectCommand — Eck-Radius", () => {
  it("Default ist 0 (scharfe Ecken)", () => {
    expect(rectCommand.options(rectCommand.init()).find((o) => o.id === "radius")?.value).toBe("0");
  });

  it("zyklt 0 → 0.02 → 0.05 → 0.1 → 0.2 → 0.3 → 0", () => {
    const ctx = makeCtx(project());
    let state = rectCommand.init() as CommandState;
    const seq = [0.02, 0.05, 0.1, 0.2, 0.3, 0];
    for (const target of seq) {
      state = setRadius(state, ctx, target);
      expect(rectCommand.options(state).find((o) => o.id === "radius")?.value).toBe(String(target));
    }
  });

  it("Radius > 0 committet eine geschlossene 'polyline' mit bulge statt 'rect' (2-Punkt-Methode)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setRadius(rectCommand.init(), ctx, 0.2);
    [state] = rectCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [, result] = rectCommand.onInput(state, { kind: "point", point: { x: 4, y: 2 } }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape === "polyline") {
      expect(g.closed).toBe(true);
      expect(g.pts.length).toBe(8); // 2 Tangentenpunkte je der 4 Ecken
      expect(g.bulge?.length).toBe(8);
      // Genau 4 Bogensegmente (Fillets), 4 gerade (die Kanten dazwischen).
      const realBulges = (g.bulge ?? []).filter((b) => Math.abs(b) > 1e-9);
      expect(realBulges.length).toBe(4);
      // Die Tangentenpunkte der Ecke (0,0) liegen exakt Radius 0.2 von der
      // ursprünglichen scharfen Ecke entfernt, auf beiden angrenzenden Kanten.
      const nearOrigin = g.pts.filter((pt) => dist(pt, { x: 0, y: 0 }) < 1); // grobe Vorauswahl
      expect(nearOrigin.length).toBe(2);
      for (const pt of nearOrigin) expect(dist(pt, { x: 0, y: 0 })).toBeCloseTo(0.2, 6);
    }
  });

  it("Radius 0 bleibt weiterhin 'rect' (byte-identisch zum alten Verhalten)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setRadius(rectCommand.init(), ctx, 0);
    [state] = rectCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [, result] = rectCommand.onInput(state, { kind: "point", point: { x: 4, y: 2 } }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d[0].geom.shape).toBe("rect");
  });

  it("wird auf die halbe kürzere Kantenlänge geklammert (Radius grösser als möglich)", () => {
    const p = project();
    const ctx = makeCtx(p);
    // Rechteck 1×0.4 — kürzere Kante 0.4, max. sinnvoller Radius 0.2.
    let state = setRadius(rectCommand.init(), ctx, 0.3);
    [state] = rectCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [, result] = rectCommand.onInput(state, { kind: "point", point: { x: 1, y: 0.4 } }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape === "polyline") {
      const nearOrigin = g.pts.filter((pt) => dist(pt, { x: 0, y: 0 }) < 0.3);
      for (const pt of nearOrigin) {
        expect(dist(pt, { x: 0, y: 0 })).toBeLessThanOrEqual(0.2 + 1e-6);
      }
    }
  });

  it("wirkt auch bei der Zentrum-Methode", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setRadius(rectCommand.init(), ctx, 0.05);
    [state] = rectCommand.onInput(state, { kind: "option", id: "method" }, ctx); // corner → three
    [state] = rectCommand.onInput(state, { kind: "option", id: "method" }, ctx); // three → center
    expect(rectCommand.options(state).find((o) => o.id === "method")?.value).toBe("center");
    [state] = rectCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx); // Mittelpunkt
    const [, result] = rectCommand.onInput(state, { kind: "point", point: { x: 2, y: 1 } }, ctx); // Ecke
    const next = result.commit!(p);
    expect(next.drawings2d[0].geom.shape).toBe("polyline");
  });

  it("wirkt bei der 3-Punkt-Methode (gedreht) — Ergebnis bleibt eine 'polyline' mit bulge", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setRadius(rectCommand.init(), ctx, 0.05);
    [state] = rectCommand.onInput(state, { kind: "option", id: "method" }, ctx); // corner → three
    expect(rectCommand.options(state).find((o) => o.id === "method")?.value).toBe("3pt");
    [state] = rectCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx); // Basis-Start
    [state] = rectCommand.onInput(state, { kind: "point", point: { x: 2, y: 0 } }, ctx); // Basis-Ende
    const [, result] = rectCommand.onInput(state, { kind: "point", point: { x: 0, y: 1 } }, ctx); // Höhe
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape === "polyline") {
      const realBulges = (g.bulge ?? []).filter((b) => Math.abs(b) > 1e-9);
      expect(realBulges.length).toBe(4);
    }
  });
});
