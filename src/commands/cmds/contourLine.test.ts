/**
 * [332] `contourLineCommand` — gezeichnete Linie anklicken + Höhe tippen → Gelände-Höhenlinie; der Befehl wartet auf die
 * nächste Linie und schlägt letzte Höhe + Äquidistanz vor; aus den Höhenlinien entsteht mit „Gelände" ein Netz.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { contourLineCommand, resetContourLineDefaults, suggestedZ } from "./contourLine";
import { terrainCommand } from "./terrain";
import type { CommandContext, CommandState, Project } from "../types";

const line = (id: string, y: number, x0 = 0, x1 = 20) => ({
  id,
  type: "drawing2d" as const,
  levelId: "eg",
  categoryCode: "20",
  geom: { shape: "spline" as const, pts: [{ x: x0, y }, { x: (x0 + x1) / 2, y: y + 0.5 }, { x: x1, y }], closed: false },
});

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers: [
      { code: "14", name: "Höhenlinien", color: "#888888", lw: 0.1, visible: true, locked: false },
      { code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
    ],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [line("a", 0), line("b", 5), line("c", 10)],
    context: [],
  } as Project;
}

const ctxOf = (p: Project, drawingIds: string[] = []): CommandContext => ({
  project: p,
  level: p.drawingLevels[0],
  defaultCategoryCode: "20",
  activeLineStyleId: "solid",
  activeWallTypeId: "aw",
  lastPoint: null,
  selection: { wallIds: [], drawingId: drawingIds[0] ?? null, drawingIds },
});

const contours = (p: Project) => (p.context ?? []).flatMap((o) => (o.type === "contourSet" ? o.contours : []));

describe("contourLineCommand", () => {
  beforeEach(() => resetContourLineDefaults());

  it("Linie anklicken, Höhe tippen → Höhenlinie; nächste Linie mit Vorschlag (Enter); dann Gelände", () => {
    let p = project();
    const cmd = contourLineCommand;
    let s: CommandState = cmd.init();
    // Daneben geklickt: Hinweis, kein Wechsel.
    let [ns, r] = cmd.onInput(s, { kind: "point", point: { x: 10, y: 2.5 } }, ctxOf(p));
    expect(ns.phase).toBe("pick");
    expect(r.notice?.key).toBe("cmd.contourLine.noLine");
    // Erste Linie (y = 0) mit 450.
    [s] = cmd.onInput(s, { kind: "point", point: { x: 0.05, y: 0 } }, ctxOf(p));
    expect(s.phase).toBe("height");
    [s, r] = cmd.onInput(s, { kind: "number", value: 450 }, ctxOf(p));
    p = r.commit!(p);
    expect(s.phase).toBe("pick");
    expect(contours(p).map((c) => c.z)).toEqual([450]);
    expect(p.drawings2d.map((d) => d.id)).toEqual(["b", "c"]);
    // Zweite mit 451 → Äquidistanz 1; dritte per Enter: Vorschlag 452.
    [s] = cmd.onInput(s, { kind: "point", point: { x: 0.05, y: 5 } }, ctxOf(p));
    [s, r] = cmd.onInput(s, { kind: "number", value: 451 }, ctxOf(p));
    p = r.commit!(p);
    expect(suggestedZ(p)).toBe(452);
    [s] = cmd.onInput(s, { kind: "point", point: { x: 0.05, y: 10 } }, ctxOf(p));
    [s, r] = cmd.onConfirm(s, ctxOf(p));
    p = r.commit!(p);
    expect(contours(p).map((c) => c.z)).toEqual([450, 451, 452]);
    expect(p.drawings2d).toEqual([]);
    // Ein Satz der Klasse „14".
    const sets = (p.context ?? []).filter((o) => o.type === "contourSet");
    expect(sets.map((o) => o.categoryCode)).toEqual(["14"]);
    // Enter beim Wählen: fertig, mit Hinweis.
    [, r] = cmd.onConfirm(s, ctxOf(p));
    expect(r.done).toBe(true);
    expect(r.notice?.key).toBe("cmd.contourLine.done");
    // Gelände aus den gezeichneten Höhenlinien.
    const t = terrainCommand.autoRun!(ctxOf(p));
    const withTerrain = t.commit!(p);
    const mesh = (withTerrain.context ?? []).find((o) => o.type === "terrainMesh");
    expect(mesh && mesh.type === "terrainMesh" ? mesh.indices.length : 0).toBeGreaterThan(0);
  });

  it("vorgewählte Linie: getippte Zahl ist gleich ihre Höhe", () => {
    const p = project();
    const [, r] = contourLineCommand.onInput(contourLineCommand.init(), { kind: "number", value: 3.5 }, ctxOf(p, ["b"]));
    const next = r.commit!(p);
    expect(contours(next).map((c) => c.z)).toEqual([3.5]);
    expect(next.drawings2d.map((d) => d.id)).toEqual(["a", "c"]);
  });
});
