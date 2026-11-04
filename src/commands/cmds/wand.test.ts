/** `wandCommand` ([77]): Klick in ein Rechteck aus vier Linien → geschlossene Polylinie mit Schraffur; daneben nichts. */
import { describe, expect, it } from "vitest";
import { wandCommand } from "./wand";
import type { CommandContext, Project } from "../types";
import type { Drawing2D } from "../../model/types";

const line = (id: string, a: [number, number], b: [number, number]): Drawing2D =>
  ({ id, levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } } }) as Drawing2D;

function project(): Project {
  return {
    id: "t", name: "T", lineStyles: [], components: [], wallTypes: [],
    hatches: [{ id: "h1", name: "Beton", pattern: "diagonal", spacing: 0.1, angle: 45 } as unknown as Project["hatches"][number]],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [], openings: [], ceilings: [], stairs: [], rooms: [], context: [],
    drawings2d: [line("a", [0, 0], [3, 0]), line("b", [3, 0], [3, 2]), line("c", [3, 2], [0, 2]), line("d", [0, 2], [0, 0])],
  };
}

const ctxOf = (p: Project): CommandContext =>
  ({ project: p, level: p.drawingLevels[0], defaultCategoryCode: "20", activeLineStyleId: "solid", activeWallTypeId: "aw", lastPoint: null, selection: { wallIds: [], drawingId: null } }) as CommandContext;

describe("wandCommand", () => {
  it("Klick in die Fläche: geschlossene Polylinie mit der ersten Schraffur", () => {
    const p = project();
    const ctx = ctxOf(p);
    const [, r] = wandCommand.onInput(wandCommand.init(), { kind: "point", point: { x: 1, y: 1 } }, ctx);
    expect(r.commit).toBeDefined();
    const next = r.commit!(p);
    const d = next.drawings2d[next.drawings2d.length - 1];
    expect(d.geom.shape).toBe("polyline");
    expect(d.hatchId).toBe("h1");
    if (d.geom.shape === "polyline") expect(d.geom.closed).toBe(true);
  });

  it("Klick ausserhalb: kein Commit, Befehl bleibt aktiv", () => {
    const p = project();
    const [, r] = wandCommand.onInput(wandCommand.init(), { kind: "point", point: { x: 9, y: 9 } }, ctxOf(p));
    expect(r.commit).toBeUndefined();
    expect(r.done).toBeFalsy();
  });
});
