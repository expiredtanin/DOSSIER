// Wand-Editierbefehle ([113]): Trim, Extend, Teilen, Bruch, Verrunden, Verketten und Offset an Wänden über
// die Befehls-Automaten (Treffer und Ops rechnet der Kern, `cmd_wall_edit.rs`).
import { describe, expect, it } from "vitest";
import { sampleProject } from "../../model/sampleProject";
import type { Opening, Project, Wall } from "../../model/types";
import type { CmdInput, Command, CommandContext } from "../types";
import type { ProjectMutation } from "../../core";
import { trimCommand } from "./trim";
import { extendCommand } from "./extend";
import { splitCommand } from "./split";
import { breakCommand } from "./break";
import { filletCommand } from "./fillet";
import { joinCommand } from "./join";
import { offsetCommand } from "./offset";
import { chamferCommand } from "./chamfer";

const level = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
const wt = sampleProject.wallTypes[0].id;
const wall = (id: string, a: [number, number], b: [number, number], bulge?: number): Wall => ({
  id,
  type: "wall",
  floorId: level.id,
  categoryCode: "20",
  start: { x: a[0], y: a[1] },
  end: { x: b[0], y: b[1] },
  ...(bulge !== undefined ? { bulge } : {}),
  wallTypeId: wt,
  height: 2.6,
});
const opening = (id: string, host: string, position: number): Opening =>
  ({ id, type: "opening", hostWallId: host, categoryCode: "21", kind: "window", position, width: 1, height: 1.2, sillHeight: 0.9 }) as Opening;
const proj = (walls: Wall[], openings: Opening[] = [], drawings2d: Project["drawings2d"] = []): Project => ({ ...sampleProject, walls, openings, drawings2d, rooms: [], ceilings: [], stairs: [] });
const line2d = (id: string, a: [number, number], b: [number, number]) =>
  ({ id, type: "drawing2d", levelId: level.id, categoryCode: "20", geom: { shape: "line", a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } } }) as Project["drawings2d"][number];

function run(cmd: Command, p: Project, inputs: CmdInput[], wallIds: string[] = []): Project {
  const ctx: CommandContext = {
    project: p,
    level,
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: wt,
    lastPoint: null,
    selection: { wallIds, drawingId: null, drawingIds: [] },
  };
  let st = cmd.init();
  let fn: ProjectMutation | undefined = cmd.autoRun?.(ctx).commit;
  for (const input of inputs) {
    const [ns, res] = cmd.onInput(st, input, ctx);
    st = ns;
    if (res.commit) fn = res.commit;
  }
  return fn ? fn(p) : p;
}
const pt = (x: number, y: number): CmdInput => ({ kind: "point", point: { x, y } });
const byId = (p: Project, id: string) => p.walls.find((w) => w.id === id)!;

describe("Wand-Editierbefehle ([113])", () => {
  it("Trim an der Querwand: Ende auf deren Achse, Öffnung im Rest bleibt, die weggeschnittene entfällt", () => {
    const p = proj([wall("a", [0, 0], [10, 0]), wall("b", [6, -3], [6, 3])], [opening("o1", "a", 1), opening("o2", "a", 7)]);
    const out = run(trimCommand, p, [pt(8, 0.02)]);
    expect(byId(out, "a").end).toEqual({ x: 6, y: 0 });
    expect(out.openings!.map((o) => o.id)).toEqual(["o1"]);
  });

  it("Extend bis zur Achse bzw. (Option Fläche) bis zur Fläche", () => {
    const p = proj([wall("a", [0, 0], [4, 0]), wall("b", [6, -3], [6, 3])]);
    expect(byId(run(extendCommand, p, [pt(3.9, 0)]), "a").end).toEqual({ x: 6, y: 0 });
    const half = sampleProject.wallTypes[0].layers.reduce((s, l) => s + l.thickness, 0) / 2;
    const face = run(extendCommand, p, [{ kind: "option", id: "face" }, pt(3.9, 0)]);
    run(extendCommand, p, [{ kind: "option", id: "face" }]); // Option zurück (bleibt über Aufrufe)
    expect(byId(face, "a").end.x).toBeCloseTo(6 - half, 9);
  });

  it("Teilen am Punkt: zwei Wände, Öffnung hängt am zweiten Stück mit umgerechneter Lage", () => {
    const p = proj([wall("a", [0, 0], [10, 0])], [opening("o", "a", 7)]);
    const out = run(splitCommand, p, [pt(4, 0.05)]);
    expect(out.walls).toHaveLength(2);
    expect(byId(out, "a").end).toEqual({ x: 4, y: 0 });
    const second = out.walls.find((w) => w.id !== "a")!;
    expect(out.openings![0].hostWallId).toBe(second.id);
    expect(out.openings![0].position).toBeCloseTo(3, 9);
  });

  it("Teilen an Schnittpunkten einer Bogenwand", () => {
    const p = proj([wall("a", [-5, 0], [5, 0], 1), wall("b", [0, -8], [0, 8])]);
    const out = run(splitCommand, p, [{ kind: "option", id: "inter" }, pt(-5, 0.01)]);
    run(splitCommand, p, [{ kind: "option", id: "inter" }]);
    const arcs = out.walls.filter((w) => w.id !== "b");
    expect(arcs).toHaveLength(2);
    for (const w of arcs) expect(w.bulge).toBeCloseTo(Math.tan(Math.PI / 8), 9);
  });

  it("Bruch: das Stück zwischen zwei Punkten entfällt", () => {
    const p = proj([wall("a", [0, 0], [10, 0])]);
    const out = run(breakCommand, p, [pt(3, 0), pt(5, 0)]);
    expect(out.walls.map((w) => [w.start.x, w.end.x])).toEqual([
      [0, 3],
      [5, 10],
    ]);
  });

  it("Verrunden zweier Wände: L-Ecke am Achsschnittpunkt, mit Radius eine Bogenwand", () => {
    const p = proj([wall("a", [0, 0], [4, 0]), wall("b", [6, 5], [6, -2])]);
    const l = run(filletCommand, p, [pt(2, 0), pt(6, 3)]);
    expect(byId(l, "a").end).toEqual({ x: 6, y: 0 });
    expect(byId(l, "b").end).toEqual({ x: 6, y: 0 });
    const r = run(filletCommand, p, [pt(2, 0), { kind: "number", value: 1 }, pt(6, 3)]);
    run(filletCommand, p, [pt(2, 0), { kind: "number", value: 0 }]);
    expect(r.walls).toHaveLength(3);
    const arc = r.walls.find((w) => w.bulge)!;
    expect(arc.start.x).toBeCloseTo(5, 9);
    expect(arc.end.y).toBeCloseTo(1, 9);
  });

  it("Verketten kollinearer Wände und Offset", () => {
    const p = proj([wall("a", [0, 0], [4, 0]), wall("b", [4, 0], [10, 0])], [opening("o", "b", 1)]);
    const j = run(joinCommand, p, [], ["a", "b"]);
    expect(j.walls).toHaveLength(1);
    expect(j.walls[0].end).toEqual({ x: 10, y: 0 });
    expect(j.openings![0]).toMatchObject({ hostWallId: "a", position: 5 });
    const o = run(offsetCommand, proj([wall("a", [0, 0], [4, 0])]), [{ kind: "number", value: 2 }], ["a"]);
    expect(o.walls).toHaveLength(2);
    expect(Math.abs(o.walls[1].start.y)).toBeCloseTo(2, 9);
  });
  it("Verrunden mit Radius an einer Bogenwand: tangentiale Bogenwand, Öffnung bleibt", () => {
    // Halbkreis R 5 um (0,0) oben herum, Gerade x = 3 nach oben; Schnitt (3,4).
    const p = proj([wall("a", [-5, 0], [5, 0], 1), wall("b", [3, -2], [3, 8])], [opening("o", "a", 1)]);
    const out = run(filletCommand, p, [pt(-4, 3), { kind: "number", value: 1 }, pt(3, 7)]);
    run(filletCommand, p, [pt(-4, 3), { kind: "number", value: 0 }]);
    expect(out.walls).toHaveLength(3);
    const cy = Math.sqrt(32);
    expect(byId(out, "a").end.x).toBeCloseTo(10 / 6, 9);
    expect(byId(out, "a").end.y).toBeCloseTo((5 * cy) / 6, 9);
    expect(byId(out, "b").start).toMatchObject({ x: 3 });
    expect(byId(out, "b").start.y).toBeCloseTo(cy, 9);
    const f = out.walls.find((w) => w.id !== "a" && w.id !== "b")!;
    expect(f.bulge).toBeTruthy();
    expect(out.openings![0]).toMatchObject({ hostWallId: "a", position: 1 });
  });

  it("Fasen zweier Wände: gerade Wand zwischen den Enden, Distanz getippt", () => {
    const p = proj([wall("a", [0, 0], [4, 0]), wall("b", [6, 5], [6, -2])]);
    const out = run(chamferCommand, p, [pt(2, 0), { kind: "number", value: 1 }, pt(6, 3)]);
    run(chamferCommand, p, [pt(2, 0), { kind: "number", value: 0 }]);
    expect(byId(out, "a").end).toEqual({ x: 5, y: 0 });
    expect(byId(out, "b").end).toEqual({ x: 6, y: 1 });
    const f = out.walls.find((w) => w.id !== "a" && w.id !== "b")!;
    expect(f.start).toEqual({ x: 5, y: 0 });
    expect(f.end).toEqual({ x: 6, y: 1 });
    expect(f.bulge).toBeUndefined();
    expect(f.wallTypeId).toBe(wt);
  });

  it("Verketten gegenläufiger Wände: Tür behält Weltlage, Aufschlag und Scharnier gekehrt", () => {
    const door = { ...opening("d", "b", 1), kind: "door", swing: "left", hinge: "start" } as Opening;
    const p = proj([wall("a", [0, 0], [4, 0]), wall("b", [10, 0], [4, 0])], [door]);
    const j = run(joinCommand, p, [], ["a", "b"]);
    expect(j.walls).toHaveLength(1);
    expect(j.walls[0].end).toEqual({ x: 10, y: 0 });
    expect(j.openings![0]).toMatchObject({ hostWallId: "a", position: 8, swing: "right", hinge: "end" });
  });

  it("2D-Linien an Wänden stutzen und verlängern", () => {
    const p = proj([wall("a", [-5, 0], [5, 0])], [], [line2d("l", [2, -3], [2, 3])]);
    const t = run(trimCommand, p, [pt(2, 2)]);
    expect(t.walls).toHaveLength(1);
    expect(t.drawings2d).toHaveLength(1);
    expect((t.drawings2d[0].geom as { b: { x: number; y: number } }).b).toEqual({ x: 2, y: 0 });
    const e = run(extendCommand, proj([wall("a", [-5, 0], [5, 0])], [], [line2d("l", [2, -3], [2, -1])]), [pt(2, -1.1)]);
    expect((e.drawings2d[0].geom as { b: { x: number; y: number } }).b).toEqual({ x: 2, y: 0 });
  });
});
