/**
 * `polygonCommand` — Mittelpunkt + Radius → geschlossene `polyline` mit N
 * (Default 6) gleichmässig verteilten Eckpunkten auf dem Umkreis.
 */

import { describe, it, expect } from "vitest";
import { polygonCommand } from "./polygon";
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

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(b.x - a.x, b.y - a.y);

describe("polygonCommand", () => {
  it("Mittelpunkt + Radius-Punkt → geschlossene Polylinie mit 6 Eckpunkten auf dem Umkreis", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterCenter] = polygonCommand.onInput(
      polygonCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [, result] = polygonCommand.onInput(
      afterCenter,
      { kind: "point", point: { x: 5, y: 0 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape === "polyline") {
      expect(g.closed).toBe(true);
      expect(g.pts.length).toBe(6);
      // Erste Ecke exakt in Klickrichtung (+X) im Klickabstand.
      expect(g.pts[0].x).toBeCloseTo(5, 6);
      expect(g.pts[0].y).toBeCloseTo(0, 6);
      // Alle Eckpunkte liegen auf dem Umkreis mit Radius 5.
      for (const pt of g.pts) expect(dist({ x: 0, y: 0 }, pt)).toBeCloseTo(5, 6);
    }
  });

  it("Ecken-Zahl per Option zyklt 3..12 und zurück zu 3", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = polygonCommand.onInput(
      polygonCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    // Von Default 6 hoch bis 12, dann Wrap auf 3.
    const sidesValue = () => polygonCommand.options(state).find((o) => o.id === "sides")?.value;
    expect(sidesValue()).toBe("6");
    for (let i = 0; i < 6; i++) {
      [state] = polygonCommand.onInput(state, { kind: "option", id: "sides" }, ctx);
    }
    expect(sidesValue()).toBe("12");
    [state] = polygonCommand.onInput(state, { kind: "option", id: "sides" }, ctx);
    expect(sidesValue()).toBe("3");

    const [, result] = polygonCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "polyline") expect(g.pts.length).toBe(3);
  });

  it("entarteter Radius (Punkt=Mittelpunkt) committet nichts", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterCenter] = polygonCommand.onInput(
      polygonCommand.init(),
      { kind: "point", point: { x: 2, y: 2 } },
      ctx,
    );
    const [, result] = polygonCommand.onInput(
      afterCenter,
      { kind: "point", point: { x: 2, y: 2 } },
      ctx,
    );
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(0);
  });
});

/** Treibt die „mode"-Option auf den Ziel-Wert, unabhängig vom aktuellen Modul-Zustand
 *  (`lastMode` ist ein Modul-Singleton, s. Leader/Array-Tests für dasselbe Muster). */
function setMode(state: CommandState, ctx: CommandContext, target: "insc" | "circ"): CommandState {
  let s = state;
  let opts = polygonCommand.options(s);
  while (opts.find((o) => o.id === "mode")?.value !== target) {
    [s] = polygonCommand.onInput(s, { kind: "option", id: "mode" }, ctx);
    opts = polygonCommand.options(s);
  }
  return s;
}

/** Treibt die „sides"-Option auf den Ziel-Wert (`lastSides` ist ebenfalls ein
 *  Modul-Singleton — die vorherige Beschreibung „Ecken-Zahl…" lässt ihn bei 3
 *  stehen, andere Tests hier dürfen sich darauf nicht verlassen). */
function setSides(state: CommandState, ctx: CommandContext, target: number): CommandState {
  let s = state;
  let opts = polygonCommand.options(s);
  while (opts.find((o) => o.id === "sides")?.value !== String(target)) {
    [s] = polygonCommand.onInput(s, { kind: "option", id: "sides" }, ctx);
    opts = polygonCommand.options(s);
  }
  return s;
}

describe("polygonCommand — Modus eingeschrieben/umschrieben", () => {
  it("Default ist 'eingeschrieben' (insc) — Eckpunkte liegen exakt auf dem Klick-Radius", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [state] = polygonCommand.onInput(polygonCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    expect(polygonCommand.options(state).find((o) => o.id === "mode")?.value).toBe("insc");
  });

  it("Modus zyklt insc → circ → insc", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = polygonCommand.onInput(polygonCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    state = setMode(state, ctx, "circ");
    expect(polygonCommand.options(state).find((o) => o.id === "mode")?.value).toBe("circ");
    state = setMode(state, ctx, "insc");
    expect(polygonCommand.options(state).find((o) => o.id === "mode")?.value).toBe("insc");
  });

  it("umschrieben: der Eckpunkt-Radius ist GRÖSSER als der eingegebene Radius (Apothema)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = polygonCommand.onInput(polygonCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    state = setMode(state, ctx, "circ");
    state = setSides(state, ctx, 6);
    // 6 Ecken (Default), Apothema = 5 → Eckpunkt-Radius = 5 / cos(30°) ≈ 5.7735.
    const [, result] = polygonCommand.onInput(state, { kind: "point", point: { x: 5, y: 0 } }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "polyline") {
      expect(g.pts.length).toBe(6);
      const r = Math.hypot(g.pts[0].x, g.pts[0].y);
      expect(r).toBeCloseTo(5 / Math.cos(Math.PI / 6), 6);
      // Die Kantenmitte (Mittelwert zweier benachbarter Ecken) liegt auf dem
      // eingegebenen Apothema-Radius (5) — das definiert „umschrieben".
      const midEdge = { x: (g.pts[0].x + g.pts[1].x) / 2, y: (g.pts[0].y + g.pts[1].y) / 2 };
      expect(Math.hypot(midEdge.x, midEdge.y)).toBeCloseTo(5, 6);
    }
  });

  it("eingeschrieben (explizit gesetzt): Eckpunkt-Radius = eingegebener Radius, unverändert", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = polygonCommand.onInput(polygonCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    state = setMode(state, ctx, "insc");
    const [, result] = polygonCommand.onInput(state, { kind: "point", point: { x: 5, y: 0 } }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "polyline") {
      for (const pt of g.pts) expect(Math.hypot(pt.x, pt.y)).toBeCloseTo(5, 6);
    }
  });
});

/** Treibt die „construct"-Option auf den Ziel-Wert (Modul-Singleton `lastMethod`,
 *  dasselbe Muster wie `setMode`/`setSides`). */
function setConstruct(state: CommandState, ctx: CommandContext, target: "center" | "edge"): CommandState {
  let s = state;
  let opts = polygonCommand.options(s);
  while (opts.find((o) => o.id === "construct")?.value !== target) {
    [s] = polygonCommand.onInput(s, { kind: "option", id: "construct" }, ctx);
    opts = polygonCommand.options(s);
  }
  return s;
}

describe("polygonCommand — Konstruktion 'Kante' (zwei Punkte legen eine Kante fest)", () => {
  it("Default-Konstruktion ist 'center'", () => {
    expect(polygonCommand.options(polygonCommand.init()).find((o) => o.id === "construct")?.value).toBe(
      "center",
    );
  });

  it("Konstruktion zyklt center → edge → center", () => {
    const ctx = makeCtx(project());
    let state = setConstruct(polygonCommand.init(), ctx, "edge");
    expect(polygonCommand.options(state).find((o) => o.id === "construct")?.value).toBe("edge");
    state = setConstruct(state, ctx, "center");
    expect(polygonCommand.options(state).find((o) => o.id === "construct")?.value).toBe("center");
  });

  it("Quadrat (4 Ecken) aus einer horizontalen Kante (0,0)→(2,0): alle 4 Seiten gleich lang, rechte Winkel", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setConstruct(polygonCommand.init(), ctx, "edge");
    state = setSides(state, ctx, 4);
    [state] = polygonCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [, result] = polygonCommand.onInput(state, { kind: "point", point: { x: 2, y: 0 } }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    expect(g.shape).toBe("polyline");
    if (g.shape === "polyline") {
      expect(g.pts.length).toBe(4);
      expect(g.pts[0]).toEqual({ x: 0, y: 0 });
      expect(g.pts[1]).toEqual({ x: 2, y: 0 });
      // Alle vier Kanten exakt Länge 2 (Quadrat), links von der Kante 0→1 abbiegend.
      for (let i = 0; i < 4; i++) {
        expect(dist(g.pts[i], g.pts[(i + 1) % 4])).toBeCloseTo(2, 6);
      }
      expect(g.pts[2].y).toBeGreaterThan(0); // links von (0,0)→(2,0) = +Y-Seite
    }
  });

  it("gleichseitiges Dreieck (3 Ecken) aus einer Kante — dritte Ecke exakt auf der Mittelsenkrechten", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setConstruct(polygonCommand.init(), ctx, "edge");
    state = setSides(state, ctx, 3);
    [state] = polygonCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [, result] = polygonCommand.onInput(state, { kind: "point", point: { x: 2, y: 0 } }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "polyline") {
      expect(g.pts.length).toBe(3);
      const apex = g.pts[2];
      expect(apex.x).toBeCloseTo(1, 6); // Mittelsenkrechte von (0,0)-(2,0)
      expect(apex.y).toBeCloseTo(Math.sqrt(3), 6); // Höhe eines gleichseitigen Δ mit Seite 2
    }
  });

  it("Klick auf denselben Punkt (Nulllänge) wird ignoriert, bleibt in Phase 'edge2'", () => {
    const ctx = makeCtx(project());
    let state = setConstruct(polygonCommand.init(), ctx, "edge");
    [state] = polygonCommand.onInput(state, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    const [after, result] = polygonCommand.onInput(state, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    expect(result.commit).toBeUndefined();
    expect((after as { phase: string }).phase).toBe("edge2");
  });

  it("Wechsel zurück auf 'center' funktioniert nach einer Kanten-Konstruktion weiterhin normal", () => {
    const p = project();
    const ctx = makeCtx(p);
    let state = setConstruct(polygonCommand.init(), ctx, "center");
    [state] = polygonCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [, result] = polygonCommand.onInput(state, { kind: "point", point: { x: 3, y: 0 } }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d[0].geom.shape).toBe("polyline");
  });
});
