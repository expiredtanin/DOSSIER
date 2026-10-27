// setProject läuft über Ops (core/ops.ts): das Ergebnis muss dem gewünschten Projekt gleichen,
// ungültige Änderungen werden zurückgerollt, Ops werden protokolliert und sind JSON-fähig.
import { describe, expect, it } from "vitest";
import { getState } from "./appStore";
import { sampleProject } from "../model/sampleProject";

const st = () => getState();

describe("setProject über CoreOps", () => {
  it("Änderung kommt unverändert an, Op wird protokolliert (JSON-fähig), Undo stellt zurück", () => {
    st().setProject(structuredClone(sampleProject));
    const before = st().project;
    const w = before.walls[0];
    const wanted = { ...before, walls: [{ ...w, height: (w.height ?? 2.6) + 1 }, ...before.walls.slice(1)] };
    st().setProject(wanted);
    expect(st().project).toEqual(wanted);
    const ops = st().recentOps();
    expect(ops.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(ops.at(-1)))).toEqual(ops.at(-1));
    st().undo();
    expect(st().project).toBe(before);
  });

  it("NaN-Änderung wird verworfen, Projekt bleibt, Undo-Stapel unverändert", () => {
    const before = st().project;
    const depth = st().undoStack.length;
    const w = before.walls[0];
    st().setProject({ ...before, walls: [{ ...w, height: NaN }, ...before.walls.slice(1)] });
    expect(st().project).toBe(before);
    expect(st().undoStack.length).toBe(depth);
  });

  it("doppelte ids beim Einfügen werden verworfen", () => {
    const before = st().project;
    st().setProject({ ...before, walls: [...before.walls, { ...before.walls[0] }] });
    expect(st().project).toBe(before);
  });
});
