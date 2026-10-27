/**
 * `multilineCommand` — zeichnet eine Basislinie + N-1 parallele Kopien in
 * einer Geste (baut auf `offsetSegment` auf, wie der bestehende `offset`-
 * Befehl). Test: Start → Ende → Abstand (getippt) → commit erzeugt die
 * erwartete Anzahl paralleler Linien.
 */

import { describe, it, expect } from "vitest";
import { multilineCommand } from "./multiline";
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

describe("multilineCommand", () => {
  it("Basislinie + 2 Kopien (Default-Anzahl 3) bei getipptem Abstand", () => {
    const p = project();
    const ctx = makeCtx(p);

    const [afterStart] = multilineCommand.onInput(
      multilineCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [afterEnd] = multilineCommand.onInput(
      afterStart,
      { kind: "point", point: { x: 10, y: 0 } },
      ctx,
    );
    const [, result] = multilineCommand.onInput(afterEnd, { kind: "number", value: 1 }, ctx);
    expect(result.commit).toBeDefined();

    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(3); // Basislinie + 2 Kopien (Default-Count)
    for (const d of next.drawings2d) {
      expect(d.geom.shape).toBe("line");
      if (d.geom.shape === "line") {
        // Alle Linien laufen horizontal von x=0 bis x=10 (nur y verschoben).
        expect(d.geom.a.x).toBeCloseTo(0, 9);
        expect(d.geom.b.x).toBeCloseTo(10, 9);
        expect(d.geom.a.y).toBeCloseTo(d.geom.b.y, 9);
      }
    }
    // Die y-Werte sind 0, ±1, ±2 (je nach Seite) — auf jeden Fall drei
    // unterschiedliche Werte im Abstand von genau 1m.
    const ys = next.drawings2d
      .map((d) => (d.geom.shape === "line" ? d.geom.a.y : NaN))
      .sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeCloseTo(1, 9);
    expect(ys[2] - ys[1]).toBeCloseTo(1, 9);
  });

  it("Null-Strecke (Start=Ende) → No-op, Befehl beendet ohne Elemente", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterStart] = multilineCommand.onInput(
      multilineCommand.init(),
      { kind: "point", point: { x: 5, y: 5 } },
      ctx,
    );
    const [, result] = multilineCommand.onInput(
      afterStart,
      { kind: "point", point: { x: 5, y: 5 } },
      ctx,
    );
    expect(result.done).toBe(true);
    expect(result.commit).toBeUndefined();
  });
});
