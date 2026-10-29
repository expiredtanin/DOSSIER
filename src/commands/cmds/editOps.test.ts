// Editier-Befehle liefern ihre Änderung als Ops ([K4] S3): Beispiele „applyOps(vorher, Ops) == erwartet"
// (die Fassung mit Projekt → Projekt wurde beim Umbau gegen die Ops-Fassung auf Zufallsprojekten verglichen).
import { describe, expect, it } from "vitest";
import { sampleProject } from "../../model/sampleProject";
import type { Drawing2D, Project } from "../../model/types";
import type { Command, CommandContext, CmdInput } from "../types";
import { explodeOps } from "../../editors/explode";
import { translateOps, translateProject } from "../../model/geoRebase";
import { applyOps } from "../../core/ops";
import type { ProjectMutation } from "../../core";
import { joinCommand } from "./join";
import { defblockCommand } from "./defblock";
import { terrainCommand } from "./terrain";
import { ceilingOpeningCommand } from "./ceilingOpening";
import { breakCommand } from "./break";
import { georefCommand } from "./georef";

const level = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
const line = (id: string, a: [number, number], b: [number, number]): Drawing2D => ({
  id,
  type: "drawing2d",
  levelId: level.id,
  categoryCode: sampleProject.layers[0].code,
  geom: { shape: "line", a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } },
});
const rect = (id: string): Drawing2D => ({
  ...line(id, [0, 0], [1, 1]),
  geom: { shape: "rect", min: { x: 0, y: 0 }, max: { x: 2, y: 1 } },
});
const withDrawings = (ds: Drawing2D[], extra: Partial<Project> = {}): Project => ({ ...sampleProject, drawings2d: ds, ...extra });

function ctxOf(p: Project, ids: string[] = []): CommandContext {
  return {
    project: p,
    level,
    defaultCategoryCode: p.layers[0].code,
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: ids[0] ?? null, drawingIds: ids },
  };
}

/** Führt die Eingaben aus und liefert das Ergebnis der letzten Commit-Funktion. */
function commitOf(cmd: Command, p: Project, inputs: CmdInput[], ids: string[] = []): { out: Project; viaOps: boolean } {
  const ctx = ctxOf(p, ids);
  let st = cmd.init();
  let fn: ProjectMutation | undefined = cmd.autoRun?.(ctx).commit;
  for (const input of inputs) {
    const [ns, res] = cmd.onInput(st, input, ctx);
    st = ns;
    if (res.commit) fn = res.commit;
  }
  return { out: fn ? fn(p) : p, viaOps: fn ? typeof fn.toOps === "function" : true };
}

describe("Editier-Befehle: Ops", () => {
  it("explode: Teile stehen an der Stelle des Originals, Nachbarn unberührt", () => {
    const p = withDrawings([line("a", [0, 0], [1, 0]), rect("r"), line("z", [5, 5], [6, 6])]);
    const out = applyOps(p, explodeOps(p, ["r"]));
    expect(out.drawings2d.map((d) => d.geom.shape)).toEqual(["line", "line", "line", "line", "line", "line"]);
    expect(out.drawings2d[0]).toBe(p.drawings2d[0]);
    expect(out.drawings2d[5]).toBe(p.drawings2d[2]);
    expect(out.drawings2d.some((d) => d.id === "r")).toBe(false);
    expect(explodeOps(p, ["a"])).toEqual([]); // Linie ist nicht zerlegbar
  });

  it("explode: zwei Originale in einer Folge (Positionen verschieben sich mit)", () => {
    const p = withDrawings([rect("r1"), line("m", [0, 0], [1, 0]), rect("r2")]);
    const out = applyOps(p, explodeOps(p, ["r1", "r2"]));
    expect(out.drawings2d).toHaveLength(9);
    expect(out.drawings2d[4].id).toBe("m");
    expect(out.drawings2d.filter((d) => d.geom.shape === "line")).toHaveLength(9);
  });

  it("join: Quellen raus, Polylinie hinten dran", () => {
    const p = withDrawings([line("a", [0, 0], [1, 0]), line("x", [9, 9], [8, 8]), line("b", [1, 0], [1, 1])]);
    const { out, viaOps } = commitOf(joinCommand, p, [], ["a", "b"]);
    expect(viaOps).toBe(true);
    expect(out.drawings2d.map((d) => d.id).slice(0, 1)).toEqual(["x"]);
    expect(out.drawings2d).toHaveLength(2);
    const g = out.drawings2d[1].geom;
    expect(g.shape).toBe("polyline");
  });

  it("defblock: Definition, Instanz hinten, Quellen weg", () => {
    const p = withDrawings([line("a", [0, 0], [1, 0]), line("b", [1, 0], [1, 1]), line("c", [4, 4], [5, 5])], { blockDefs: undefined });
    const { out, viaOps } = commitOf(defblockCommand, p, [{ kind: "point", point: { x: 1, y: 1 } }], ["a", "b"]);
    expect(viaOps).toBe(true);
    expect(out.blockDefs).toHaveLength(1);
    expect(out.blockDefs![0].geom2d).toHaveLength(2);
    expect(out.drawings2d.map((d) => d.geom.shape)).toEqual(["line", "block"]);
  });

  it("break: Ziel raus, zwei Stücke hinten dran", () => {
    const p = withDrawings([line("L", [0, 0], [10, 0]), line("o", [0, 5], [1, 5])]);
    const { out } = commitOf(breakCommand, p, [
      { kind: "point", point: { x: 3, y: 0 } },
      { kind: "point", point: { x: 7, y: 0 } },
    ]);
    expect(out.drawings2d.map((d) => d.id).slice(0, 1)).toEqual(["o"]);
    expect(out.drawings2d).toHaveLength(3);
  });

  it("terrain: ohne Höhenlinien bleibt der Kontext leer (kein Commit-Fehler)", () => {
    const none = commitOf(terrainCommand, withDrawings([], { context: [] }), [{ kind: "point", point: { x: 0, y: 0 } }]);
    expect(none.out.context).toEqual([]);
  });

  it("ceilingOpening: Aussparung in die Decke, die das Rechteck enthält", () => {
    const base = sampleProject.ceilings?.find((c) => c.floorId === level.id) ?? {
      id: "c1",
      type: "ceiling" as const,
      floorId: level.id,
      outline: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      ceilingTypeId: sampleProject.ceilingTypes?.[0]?.id ?? "x",
    };
    const ceiling = { ...base, outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], openings: undefined };
    const p = { ...sampleProject, ceilings: [ceiling] } as Project;
    const { out, viaOps } = commitOf(ceilingOpeningCommand, p, [
      { kind: "point", point: { x: 1, y: 1 } },
      { kind: "point", point: { x: 3, y: 3 } },
    ]);
    expect(viaOps).toBe(true);
    expect(out.ceilings![0].openings).toHaveLength(1);
    expect(out.ceilings![0].openings![0]).toHaveLength(4);
    // Rechteck ausserhalb: unverändert
    const miss = commitOf(ceilingOpeningCommand, p, [
      { kind: "point", point: { x: 20, y: 20 } },
      { kind: "point", point: { x: 23, y: 23 } },
    ]);
    expect(miss.out).toBe(p);
  });

  it("georef: Ops ergeben translateProject; Null-Verschiebung = keine Ops", () => {
    expect(translateOps(sampleProject, 0, 0)).toEqual([]);
    const viaOps = applyOps(sampleProject, translateOps(sampleProject, 12.5, -3));
    expect(viaOps).toEqual(translateProject(sampleProject, 12.5, -3));
    const { out } = commitOf(georefCommand, sampleProject, [{ kind: "point", point: { x: -12.5, y: 3 } }]);
    expect(out).toEqual(translateProject(sampleProject, 12.5, -3));
  });
});
