/**
 * `polygonCommand` — Mittelpunkt + Radius → geschlossene `polyline` mit N
 * (Default 6) gleichmässig verteilten Eckpunkten auf dem Umkreis.
 */

import { describe, it, expect } from "vitest";
import { polygonCommand } from "./polygon";
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
    let opts = polygonCommand.options(state);
    expect(opts[0].value).toBe("6");
    for (let i = 0; i < 6; i++) {
      [state] = polygonCommand.onInput(state, { kind: "option", id: "sides" }, ctx);
    }
    opts = polygonCommand.options(state);
    expect(opts[0].value).toBe("12");
    [state] = polygonCommand.onInput(state, { kind: "option", id: "sides" }, ctx);
    opts = polygonCommand.options(state);
    expect(opts[0].value).toBe("3");

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
