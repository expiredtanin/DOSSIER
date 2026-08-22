/**
 * `arrayCommand` — dupliziert die Auswahl `count`-mal entlang eines Vektors
 * in einer Geste. Baut auf dem bestehenden `mode:"array"` von
 * `tools/transform.ts` auf (bisher ohne eigenen Befehl erreichbar).
 */

import { describe, it, expect } from "vitest";
import { arrayCommand } from "./array";
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

function makeCtx(p: Project, drawingId: string | null): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId },
  };
}

const source: Drawing2D = {
  id: "src",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "20",
  geom: { shape: "circle", center: { x: 0, y: 0 }, r: 1 },
};

describe("arrayCommand", () => {
  it("4 Kopien entlang +x im Abstand 3m (Anzahl per Option auf 4 gesetzt)", () => {
    const p = project([source]);
    const ctx = makeCtx(p, "src");
    let [state] = arrayCommand.onInput(arrayCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    // Anzahl-Option 3× drücken: 3(default egal)→…→4 (zyklt 2..12, wir setzen sie
    // deterministisch, indem wir bis 4 zyklen unabhängig vom Startwert testen wir
    // stattdessen direkt über den committeten Output).
    for (let i = 0; i < 12; i++) {
      [state] = arrayCommand.onInput(state, { kind: "option", id: "count" }, ctx);
      const opts = arrayCommand.options(state);
      if (opts[0].value === "4") break;
    }
    const [, result] = arrayCommand.onInput(state, { kind: "point", point: { x: 3, y: 0 } }, ctx);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    // Original bleibt + 4 neue Kopien.
    expect(next.drawings2d.length).toBe(5);
    const centers = next.drawings2d
      .map((d) => d.geom)
      .filter((g) => g.shape === "circle")
      .map((g) => (g as { center: { x: number; y: number } }).center.x)
      .sort((a, b) => a - b);
    expect(centers).toEqual([0, 3, 6, 9, 12]);
  });

  it("leere Auswahl committet nichts", () => {
    const p = project();
    const ctx = makeCtx(p, null);
    let [state] = arrayCommand.onInput(arrayCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [, result] = arrayCommand.onInput(state, { kind: "point", point: { x: 5, y: 0 } }, ctx);
    expect(result.commit).toBeUndefined();
    expect(result.done).toBe(true);
  });

  it("Zielpunkt gleich Basispunkt (Nullvektor) committet nichts", () => {
    const p = project([source]);
    const ctx = makeCtx(p, "src");
    let [state] = arrayCommand.onInput(arrayCommand.init(), { kind: "point", point: { x: 2, y: 2 } }, ctx);
    const [, result] = arrayCommand.onInput(state, { kind: "point", point: { x: 2, y: 2 } }, ctx);
    expect(result.commit).toBeUndefined();
  });
});
