/**
 * `breakCommand` — zwei Klicks auf eine Linie/offene Polylinie entfernen den
 * dazwischenliegenden Abschnitt (AutoCADs BREAK).
 */

import { describe, it, expect } from "vitest";
import { breakCommand } from "./break";
import type { CommandContext, Project } from "../types";
import type { Drawing2D } from "../../model/types";

function project(drawings: Drawing2D[]): Project {
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
    drawings2d: drawings,
    context: [],
  } as unknown as Project;
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

const line: Drawing2D = {
  id: "L1",
  type: "drawing2d",
  levelId: "eg",
  categoryCode: "20",
  geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
};

describe("breakCommand", () => {
  it("zwei Klicks auf eine Linie ersetzen sie durch zwei kürzere Linien", () => {
    const p = project([line]);
    const ctx = makeCtx(p);
    let [state] = breakCommand.onInput(breakCommand.init(), { kind: "point", point: { x: 3, y: 0 } }, ctx);
    const [, result] = breakCommand.onInput(state, { kind: "point", point: { x: 7, y: 0 } }, ctx);
    expect(result.done).toBe(true);
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(2);
    const geoms = next.drawings2d.map((d) => d.geom);
    expect(geoms.every((g) => g.shape === "line")).toBe(true);
    const asLines = geoms as Extract<Drawing2D["geom"], { shape: "line" }>[];
    const spans = asLines.map((g) => [g.a.x, g.b.x].sort((a, b) => a - b));
    expect(spans).toContainEqual([0, 3]);
    expect(spans).toContainEqual([7, 10]);
  });

  it("Klick daneben (kein Treffer) bleibt im ersten Schritt, kein Commit", () => {
    const p = project([line]);
    const ctx = makeCtx(p);
    const [after, result] = breakCommand.onInput(breakCommand.init(), { kind: "point", point: { x: 3, y: 5 } }, ctx);
    expect(result.commit).toBeUndefined();
    expect((after as { phase: string }).phase).toBe("p1");
  });

  it("Klick auf eine GESCHLOSSENE Polylinie wird abgelehnt (bewusst nicht unterstützt)", () => {
    const closedPoly: Drawing2D = {
      id: "P1",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "polyline",
        pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
        closed: true,
      },
    };
    const p = project([closedPoly]);
    const ctx = makeCtx(p);
    const [after, result] = breakCommand.onInput(breakCommand.init(), { kind: "point", point: { x: 2, y: 0 } }, ctx);
    expect(result.commit).toBeUndefined();
    expect((after as { phase: string }).phase).toBe("p1");
  });

  it("Klick auf ein Bogen-Segment (bulge) wird abgelehnt (bewusst nicht unterstützt)", () => {
    const arcPoly: Drawing2D = {
      id: "P2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "20",
      geom: {
        shape: "polyline",
        pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
        closed: false,
        bulge: [1],
      },
    };
    const p = project([arcPoly]);
    const ctx = makeCtx(p);
    const [after, result] = breakCommand.onInput(breakCommand.init(), { kind: "point", point: { x: 2, y: 1 } }, ctx);
    expect(result.commit).toBeUndefined();
    expect((after as { phase: string }).phase).toBe("p1");
  });

  it("onConfirm/onCancel kehren in den Ruhezustand zurück", () => {
    const ctx = makeCtx(project([]));
    const [, res1] = breakCommand.onConfirm(breakCommand.init(), ctx);
    expect(res1.done).toBe(true);
    expect(res1.commit).toBeUndefined();
    const [, res2] = breakCommand.onCancel(breakCommand.init());
    expect(res2.done).toBe(true);
  });
});
