/**
 * `dimensionCommand` — Punktreihe (wie Polylinie) + EIN Offset-Klick → EIN
 * `shape:"dimension"`-Element für die ganze Kette (Reihenbemassung, SIA 400
 * Figur 14). Ist beim Start bereits eine Kette selektiert, ergänzt der erste
 * Klick sie (verlängert ODER fügt dazwischen ein) statt eine neue zu
 * beginnen. Die Masszahl wird NICHT gespeichert (aus dist(a,b) beim Rendern
 * abgeleitet).
 */

import { describe, it, expect } from "vitest";
import { dimensionCommand } from "./dimension";
import type { CommandContext, Project } from "../types";
import type { Drawing2D } from "../../model/types";

function project(extra: Drawing2D[] = []): Project {
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
    drawings2d: extra,
    context: [],
  };
}

function makeCtx(p: Project, selectedDrawingId: string | null = null): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: selectedDrawingId },
  };
}

describe("dimensionCommand — neu zeichnen", () => {
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
      expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
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

  it("Kette aus drei Punkten (Reihenbemassung) → EIN Element mit drei Punkten", () => {
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
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    if (g.shape === "dimension") {
      expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 10, y: 0 }]);
      expect(g.offset).toBe(2);
    }
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
    const g = next.drawings2d[0].geom;
    if (g.shape === "dimension") {
      expect(g.pts[2].y).toBeCloseTo(0, 6); // auf die Gerade y=0 projiziert
      expect(g.pts[2].x).toBeCloseTo(10, 6); // x-Komponente bleibt (Projektion entlang x)
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
    const g = next.drawings2d[0].geom;
    if (g.shape === "dimension") expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
  });

  it("entartete Kette (identische Punkte) committet nichts", () => {
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

describe("dimensionCommand — bestehende Kette ergänzen (erst selektieren, dann Befehl)", () => {
  function chain(pts: { x: number; y: number }[], offset = 1): Drawing2D {
    return {
      id: "dim-existing",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: { shape: "dimension", pts, offset },
    };
  }

  it("Klick jenseits des letzten Punkts verlängert die Kette (dasselbe Element)", () => {
    const existing = chain([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
    const p = project([existing]);
    const ctx = makeCtx(p, "dim-existing");
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 10, y: 0 } },
      ctx,
    );
    [state] = dimensionCommand.onConfirm(state, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 1 }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1); // kein neues Element
    expect(next.drawings2d[0].id).toBe("dim-existing");
    const g = next.drawings2d[0].geom;
    if (g.shape === "dimension") {
      expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 10, y: 0 }]);
    }
  });

  it("Klick vor dem ersten Punkt verlängert rückwärts (wird vorangestellt)", () => {
    const existing = chain([{ x: 4, y: 0 }, { x: 10, y: 0 }]);
    const p = project([existing]);
    const ctx = makeCtx(p, "dim-existing");
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    [state] = dimensionCommand.onConfirm(state, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 1 }, ctx);
    const next = result.commit!(p);
    const g = next.drawings2d[0].geom;
    if (g.shape === "dimension") {
      expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 10, y: 0 }]);
    }
  });

  it("Klick zwischen zwei bestehenden Punkten fügt DAZWISCHEN ein", () => {
    const existing = chain([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    const p = project([existing]);
    const ctx = makeCtx(p, "dim-existing");
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 4, y: 0 } },
      ctx,
    );
    [state] = dimensionCommand.onConfirm(state, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 1 }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const g = next.drawings2d[0].geom;
    if (g.shape === "dimension") {
      expect(g.pts).toEqual([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 10, y: 0 }]);
    }
  });

  it("keine Selektion (drawingId null) startet stattdessen eine neue Kette", () => {
    const existing = chain([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
    const p = project([existing]);
    const ctx = makeCtx(p, null);
    let [state] = dimensionCommand.onInput(
      dimensionCommand.init(),
      { kind: "point", point: { x: 20, y: 20 } },
      ctx,
    );
    [state] = dimensionCommand.onInput(state, { kind: "point", point: { x: 25, y: 20 } }, ctx);
    [state] = dimensionCommand.onConfirm(state, ctx);
    const [, result] = dimensionCommand.onInput(state, { kind: "number", value: 1 }, ctx);
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(2); // bestehendes Element bleibt, neues kommt dazu
  });
});
