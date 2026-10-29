import { describe, expect, it } from "vitest";
import { sampleProject } from "../../model/sampleProject";
import type { ExtrudedSolid } from "../../model/types";
import { documentFor } from "../../core/document";

/** Boolesche Verknüpfung zweier Körper über den Befehl im Kern (`cmd_solid.rs`); null = kein Körper. */
function combineSolids(project: typeof sampleProject, a: ExtrudedSolid, b: ExtrudedSolid, op: string): ExtrudedSolid | null {
  const p = { ...project, extrudedSolids: [a, b] };
  const ops = documentFor(p).cmdOps({ cmd: "solidbool", a: a.id, b: b.id, op, stamp: "t", ctx: { level: "eg" } });
  const add = ops.find((o) => o.kind === "add");
  return add && add.kind === "add" ? (add.items[0] as unknown as ExtrudedSolid) : null;
}

const box = (id: string, x0: number, y0: number, x1: number, y1: number, h: number): ExtrudedSolid => ({
  id,
  type: "extrudedSolid",
  levelId: "eg",
  points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  height: h,
});

describe("combineSolids", () => {
  const a = box("a", 0, 0, 4, 4, 3);
  const b = box("b", 2, 2, 6, 6, 2);

  it("Vereinigung: Grundfläche = Hüll-Rechteck, Höhe = Maximum, Boolean-Spezifikation über beiden Operanden", () => {
    const r = combineSolids(sampleProject, a, b, "union")!;
    expect(r.height).toBe(3);
    expect(r.points).toEqual([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }, { x: 0, y: 6 }]);
    expect(r.brep!.spec).toMatchObject({ kind: "boolean", op: "union", a: { kind: "extrude" }, b: { kind: "extrude" } });
    expect(r.brep!.origin).toEqual(r.points[0]);
  });

  it("Differenz behält die Grundfläche des ersten Körpers, Durchschnitt die Überlappung", () => {
    expect(combineSolids(sampleProject, a, b, "difference")!.points).toEqual(a.points);
    const i = combineSolids(sampleProject, a, b, "intersection")!;
    expect(i.points).toEqual([{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }]);
    expect(i.height).toBe(2);
  });

  it("Durchschnitt ohne Überlappung und Pyramiden als Operand ergeben null", () => {
    expect(combineSolids(sampleProject, a, box("c", 10, 10, 12, 12, 1), "intersection")).toBeNull();
    expect(combineSolids(sampleProject, { ...a, taper: 1 }, b, "union")).toBeNull();
  });
});
