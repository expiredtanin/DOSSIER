/**
 * `dimensionCommand` — Punktreihe (wie Polylinie) + EIN Offset-Klick →
 * eine oder mehrere `shape:"dimension"`-Elemente (Reihenbemassung, SIA 400
 * Figur 14). Die Masszahl wird NICHT gespeichert (aus dist(a,b) beim Rendern
 * abgeleitet).
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
  it("zwei Punkte + Enter + Offset-Klick (links positiv) → ein shape:dimension mit korrektem Vorzeichen", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 10, y: 0 } }, ctx);
    [state] = dimensionCommand.onConfirm(state, ctx);
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

  it("Fertig-Option (statt Enter) beendet die Punktreihe identisch", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    [state] = dimensionCommand.onInput(state, { kind: "option", id: "finish" }, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 1.5 }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "dimension") expect(g.offset).toBe(1.5);
  });

  it("Kette aus drei Punkten (Reihenbemassung) → zwei Segmente mit demselben Offset", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 10, y: 0 } }, ctx);
    [state] = dimensionCommand.onConfirm(state, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 2 }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(2);
    const segs = next.drawings2d.map((d) => d.geom).filter((g) => g.shape === "dimension");
    expect(segs[0]).toMatchObject({ a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 2 });
    expect(segs[1]).toMatchObject({ a: { x: 4, y: 0 }, b: { x: 10, y: 0 }, offset: 2 });
  });

  it("dritter Punkt ausserhalb der Geraden wird auf sie projiziert (keine Polylinie, immer gerade)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    // Richtung: entlang +x (y=0).
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    // Dritter Klick liegt bewusst NICHT auf der Geraden (y=3) → wird projiziert.
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 10, y: 3 } }, ctx);
    [state] = dimensionCommand.onConfirm(state, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 1 }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(2);
    const second = next.drawings2d[1].geom;
    if (second.shape === "dimension") {
      expect(second.b.y).toBeCloseTo(0, 6); // auf die Gerade y=0 projiziert
      expect(second.b.x).toBeCloseTo(10, 6); // x-Komponente bleibt (Projektion entlang x)
    }
  });

  it("Zurück-Option entfernt den letzten Punkt", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 4, y: 0 } }, ctx);
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 9, y: 0 } }, ctx);
    [state] = dimensionCommand.onInput(state, { kind: "option", id: "undo" }, ctx);
    [state] = dimensionCommand.onConfirm(state, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 1 }, ctx);
    const next = result.commit!(p);
    // Nach Zurück nur noch [0,0]→[4,0] übrig → ein Segment.
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    if (g.shape === "dimension") expect(g.b).toEqual({ x: 4, y: 0 });
  });

  it("entartetes Segment (identische Punkte) innerhalb der Kette wird übersprungen", () => {
    const p = project();
    const ctx = makeCtx(p);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 3, y: 3 } },
      ctx,
    );
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 3, y: 3 } }, ctx);
    [state] = dimensionCommand.onConfirm(state, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 1 }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(0);
  });

  it("Enter mit nur einem Punkt bricht ohne commit ab", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [, result] = dimensionCommand.onConfirm(state, ctx);
    expect(result.commit).toBeUndefined();
    expect(result.done).toBe(true);
  });
});
