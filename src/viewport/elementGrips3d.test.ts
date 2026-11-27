import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { columnTopZ, openingSillZ, elemExplodeDz, elementGrips3d } from "./elementGrips3d";

const p = buildComplexSampleProject();

describe("elementGrips3d", () => {
  it("Stütze: Mitte als Verschiebe-Griff, dazu Ecken (Index wie columnGrip)", () => {
    const c = p.columns!.find((x) => x.id === "st-carport-1")!;
    const gs = elementGrips3d(p, [], [], [c]);
    expect(gs.length).toBe(6);
    expect(gs[0]).toMatchObject({ kind: "move", index: 0, target: { columnId: c.id } });
    expect(gs[0].pos[0]).toBeCloseTo(c.position.x);
    expect(gs[0].pos[2]).toBeCloseTo(c.position.y);
    expect(gs[0].pos[1]).toBeGreaterThan(columnTopZ(p, c));
    expect(gs.slice(1).every((g) => g.kind === "vertex")).toBe(true);
  });

  it("gesperrte Stütze hat keine Griffe", () => {
    const c = { ...p.columns![0], locked: true };
    expect(elementGrips3d(p, [], [], [c])).toEqual([]);
  });

  it("Öffnung: ein Gleit-Griff auf Brüstungshöhe", () => {
    const win = p.openings!.find((o) => o.sillHeight > 0 && !o.hostRoofId && !o.hostCeilingId)!;
    const gs = elementGrips3d(p, [], [win], []);
    expect(gs).toHaveLength(1);
    expect(gs[0].kind).toBe("move");
    const w = p.walls.find((x) => x.id === win.hostWallId)!;
    expect(gs[0].planeY).toBeCloseTo(openingSillZ(p, win, w) + 0.05);
  });

  it("Treppe: Bewegpunkt zuerst, Parameter-Griffe ab Index 1", () => {
    const st = p.stairs![0];
    const gs = elementGrips3d(p, [st], [], []);
    expect(gs[0]).toMatchObject({ kind: "move", index: 0 });
    gs.slice(1).forEach((g, i) => expect(g.index).toBe(i + 1));
  });

  it("Explosion: Versatz des Geschosses", () => {
    const c = p.columns!.find((x) => x.id === "st-carport-1")!;
    expect(elemExplodeDz(p, { [c.floorId]: 3 }, { columnId: c.id })).toBe(3);
    expect(elemExplodeDz(p, {}, { columnId: c.id })).toBe(0);
  });
});
