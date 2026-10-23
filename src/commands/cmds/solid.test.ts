import { describe, expect, it } from "vitest";
import { sampleProject } from "../../model/sampleProject";
import type { CommandContext } from "../types";
import { solidCommand, solidFromInputs } from "./solid";

const ctx = { project: sampleProject, level: { id: "eg" } } as unknown as CommandContext;

function run(shape: string, steps: Array<{ kind: "point"; point: { x: number; y: number } } | { kind: "number"; value: number }>) {
  let state = solidCommand.init(ctx);
  [state] = solidCommand.onInput(state, { kind: "option", id: shape }, ctx);
  let commit: ((p: typeof sampleProject) => typeof sampleProject) | undefined;
  for (const st of steps) {
    const [ns, res] = solidCommand.onInput(state, st, ctx);
    state = ns;
    if (res.commit) commit = res.commit as typeof commit;
  }
  return commit ? commit({ ...sampleProject, extrudedSolids: [] }) : null;
}

describe("solid-Befehl", () => {
  it("Zylinder: Mittelpunkt, Radius, Höhe → ExtrudedSolid mit B-Rep-Spezifikation", () => {
    const p = run("cylinder", [
      { kind: "point", point: { x: 2, y: 3 } },
      { kind: "number", value: 0.5 },
      { kind: "number", value: 2.4 },
    ])!;
    const s = p.extrudedSolids![0];
    expect(s.levelId).toBe("eg");
    expect(s.height).toBeCloseTo(2.4, 9);
    expect(s.brep!.spec).toMatchObject({ kind: "cylinder", cx: 2, cy: 3, r: 0.5, height: 2.4, z0: 0 });
    expect(s.points).toHaveLength(48);
  });

  it("Radius per Klick: Abstand zum Mittelpunkt", () => {
    const p = run("sphere", [
      { kind: "point", point: { x: 0, y: 0 } },
      { kind: "point", point: { x: 3, y: 4 } },
    ])!;
    expect(p.extrudedSolids![0].brep!.spec).toMatchObject({ kind: "sphere", r: 5, center: [0, 0, 5] });
    expect(p.extrudedSolids![0].height).toBeCloseTo(10, 9);
  });

  it("Quader: zwei Ecken + Höhe; Torus verlangt Hauptradius > Rohrradius", () => {
    const q = run("cuboid", [
      { kind: "point", point: { x: 0, y: 0 } },
      { kind: "point", point: { x: 4, y: 2 } },
      { kind: "number", value: 3 },
    ])!;
    expect(q.extrudedSolids![0].brep!.spec).toMatchObject({ kind: "cuboid", min: [0, 0, 0], max: [4, 2, 3] });
    expect(solidFromInputs("torus", { x: 0, y: 0 }, null, [0.3, 0.5])).toBeNull();
    expect(solidFromInputs("torus", { x: 0, y: 0 }, null, [2, 0.5])?.height).toBeCloseTo(1, 9);
  });
});
