/**
 * `gridCommand` ([112]) und die Rundmass-Befehle ([38]): Eingabe → Zeichnung im Kern. Die Nachführung der
 * Bezüge im Store prüft `src/state/gridAssoc.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { gridCommand } from "./grid";
import { arcDimCommand, diameterDimCommand, radiusDimCommand } from "./dimround";
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
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: extra,
    context: [],
  };
}

function ctxOf(p: Project): CommandContext {
  return { project: p, level: p.drawingLevels[0], defaultCategoryCode: "20", activeLineStyleId: "solid", activeWallTypeId: "aw", lastPoint: null, selection: { wallIds: [], drawingId: null } };
}

describe("gridCommand", () => {
  it("Ursprung + Feldweiten → Achsraster mit Beschriftung 1, 2, 3 / A, B", () => {
    const p = project();
    const ctx = ctxOf(p);
    let [s] = gridCommand.onInput(gridCommand.init(), { kind: "point", point: { x: 2, y: 1 } }, ctx);
    [s] = gridCommand.onInput(s, { kind: "text", text: "6 4.5 3x5" }, ctx);
    const [, r] = gridCommand.onInput(s, { kind: "text", text: "5 5" }, ctx);
    expect(r.done).toBe(true);
    const g = r.commit!(p).drawings2d[0].geom;
    expect(g.shape).toBe("grid");
    if (g.shape !== "grid") return;
    expect(g.origin).toEqual({ x: 2, y: 1 });
    expect(g.a.map((x) => [x.label, x.pos])).toEqual([["1", 0], ["2", 6], ["3", 10.5], ["4", 15.5], ["5", 20.5], ["6", 25.5]]);
    expect(g.b.map((x) => [x.label, x.pos])).toEqual([["A", 0], ["B", 5], ["C", 10]]);
  });

  it("radial: Option umschalten, Strahlen und Ringe; Enter übernimmt die Vorgaben", () => {
    const p = project();
    const ctx = ctxOf(p);
    let [s] = gridCommand.onInput(gridCommand.init(), { kind: "option", id: "radial" }, ctx);
    [s] = gridCommand.onInput(s, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [s] = gridCommand.onInput(s, { kind: "text", text: "2x45" }, ctx);
    const [, r] = gridCommand.onInput(s, { kind: "text", text: "3 3" }, ctx);
    const g = r.commit!(p).drawings2d[0].geom;
    expect(g.shape === "grid" && g.radial).toBe(true);
    if (g.shape === "grid") {
      expect(g.a.map((x) => x.pos)).toEqual([0, 45, 90]);
      expect(g.b.map((x) => x.pos)).toEqual([3, 6]);
    }
    // Vorgaben (Enter, Enter) im rechtwinkligen Raster: 6 6 6 / 6 6.
    let [t] = gridCommand.onInput(gridCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [t] = gridCommand.onConfirm(t, ctx);
    const [, e] = gridCommand.onConfirm(t, ctx);
    const d = e.commit!(p).drawings2d[0].geom;
    expect(d.shape === "grid" && [d.a.length, d.b.length]).toEqual([4, 3]);
  });

  it("unlesbare Feldweiten legen nichts an; Vorschau am Cursor liefert Achsen", () => {
    const p = project();
    const ctx = ctxOf(p);
    let [s] = gridCommand.onInput(gridCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [s] = gridCommand.onInput(s, { kind: "text", text: "abc" }, ctx);
    const [, r] = gridCommand.onInput(s, { kind: "text", text: "5" }, ctx);
    expect(r.commit!(p).drawings2d.length).toBe(0);
    const [, mv] = gridCommand.onMove(gridCommand.init(), { x: 1, y: 1 }, null, ctx);
    expect(mv.draft?.preview.length).toBeGreaterThan(0);
  });
});

describe("Rundmass-Befehle", () => {
  const circle = { id: "K", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "circle", center: { x: 5, y: 5 }, r: 2 } } as Drawing2D;

  it("Radius/Durchmesser: ein Klick auf den Rand → Mass mit Bezug", () => {
    for (const [cmd, kind] of [[radiusDimCommand, "radius"], [diameterDimCommand, "diameter"]] as const) {
      const p = project([circle]);
      const [, r] = cmd.onInput(cmd.init(), { kind: "point", point: { x: 7, y: 5.02 } }, ctxOf(p));
      const g = r.commit!(p).drawings2d[1].geom;
      expect(g.shape === "dimension" && g.kind).toBe(kind);
      expect(g.shape === "dimension" && g.refs?.map((x) => x?.feature)).toEqual(["center", "rim"]);
    }
  });

  it("Bogenlänge: Anfang, Ende, Lage → drei Punkte; Klick ins Leere legt nichts an", () => {
    const p = project([circle]);
    const ctx = ctxOf(p);
    let [s] = arcDimCommand.onInput(arcDimCommand.init(), { kind: "point", point: { x: 7, y: 5 } }, ctx);
    [s] = arcDimCommand.onInput(s, { kind: "point", point: { x: 5, y: 7 } }, ctx);
    const [, r] = arcDimCommand.onInput(s, { kind: "point", point: { x: 5, y: 8 } }, ctx);
    const dim = r.commit!(p).drawings2d[1];
    expect(dim.geom.shape === "dimension" && dim.geom.pts.length).toBe(3);
    expect(dim.geom.shape === "dimension" && dim.geom.offset).toBeCloseTo(1, 6);
    const [, none] = radiusDimCommand.onInput(radiusDimCommand.init(), { kind: "point", point: { x: 50, y: 50 } }, ctx);
    expect(none.commit!(p).drawings2d.length).toBe(1);
  });
});
