// Ende-zu-Ende gegen das echte trucksolid-WASM (wie exportStep.test.ts): B-Rep-Körper,
// Mesh-Fallback bei bündigen Flächen, Eckenradius, Rotationskörper, STEP-Roundtrip.
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { sampleProject } from "../model/sampleProject";
import { combineSolids } from "../commands/cmds/solidbool";
import { extrudedSolidSpec } from "../plan/extrudedSolidSpec";
import type { ExtrudedSolid } from "../model/types";

let mod: any;
beforeAll(async () => {
  mod = await import("./pkgTruck/trucksolid.js");
  await mod.default({ module_or_path: readFileSync("src/engine/pkgTruck/trucksolid_bg.wasm") });
});

const volume = (m: { positions: number[]; indices: number[] }): number => {
  let v = 0;
  const p = (i: number) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [p(m.indices[t]), p(m.indices[t + 1]), p(m.indices[t + 2])];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return Math.abs(v);
};
const build = (spec: unknown, tol = 0.01) => JSON.parse(mod.build_solid_mesh(JSON.stringify({ spec, tol })));

const box = (id: string, x0: number, y0: number, x1: number, y1: number, h: number): ExtrudedSolid => ({
  id, type: "extrudedSolid", levelId: "eg", height: h,
  points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
});

describe("trucksolid-WASM", () => {
  it("Körper verschneiden (bündige Böden → Mesh-Fallback): Vereinigung 72 m³, Differenz 40 m³", () => {
    const a = box("a", 0, 0, 4, 4, 3);
    const b = box("b", 2, 2, 6, 6, 2);
    const u = combineSolids(sampleProject, a, b, "union")!;
    expect(volume(build(u.brep!.spec))).toBeCloseTo(48 + 32 - 8, 2);
    const d = combineSolids(sampleProject, a, b, "difference")!;
    expect(volume(build(d.brep!.spec))).toBeCloseTo(48 - 8, 2);
  }, 30_000);

  it("Verschobener Grundkörper: Mesh liegt an der neuen Stelle", () => {
    const s: ExtrudedSolid = {
      ...box("k", 5, 5, 7, 7, 2),
      brep: { spec: { kind: "cylinder", cx: 1, cy: 1, z0: 0, r: 1, height: 2 }, origin: { x: 0, y: 0 } },
    };
    const spec = extrudedSolidSpec(s, 3)!; // Verschiebung (5,5), UK 3
    const m = build(spec, 0.002);
    const xs = m.positions.filter((_: number, i: number) => i % 3 === 0);
    const zs = m.positions.filter((_: number, i: number) => i % 3 === 2);
    expect(Math.min(...xs)).toBeCloseTo(5, 2); // 1 − 1 + 5
    expect(Math.max(...xs)).toBeCloseTo(7, 2);
    expect(Math.min(...zs)).toBeCloseTo(3, 3);
    expect(Math.max(...zs)).toBeCloseTo(5, 3);
  });

  it("Eckenradius am Projekt-Körper: Volumen des abgerundeten Rechtecks", () => {
    const s: ExtrudedSolid = { ...box("r", 0, 0, 4, 3, 2), cornerRadius: 0.5 };
    expect(volume(build(extrudedSolidSpec(s, 0), 0.001))).toBeCloseTo((12 - (4 - Math.PI) * 0.25) * 2, 1);
  });

  it("Rotationskörper (Revolve) einer Rechteck-Halbebene = Zylinder", () => {
    const m = build({ kind: "revolve", profile: [0, 0, 1, 0, 1, 2, 0, 2], angleDeg: 360 }, 0.002);
    expect(volume(m)).toBeCloseTo(Math.PI * 2, 1);
  });

  it("STEP-Export und Wiedereinlesen: Wand mit Fensterloch und Zylinder behalten ihr Volumen", () => {
    // (Eingelesene Drehflächen aus eigenen Kugeln/Tori tesselliert truck-stepio unzuverlässig;
    // die Dateien selbst sind gültig — in FreeCAD geprüft. Fremd-STEP aus OCC liest sauber.)
    const wall = { kind: "extrudePlane", points: [0, 0, 5, 0, 5, 2.6, 0, 2.6], holes: [[1, 0.9, 2.2, 0.9, 2.2, 2.1, 1, 2.1]], origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], depth: -0.3 };
    const cyl = { kind: "cylinder", cx: 10, cy: 0, z0: 0, r: 1, height: 2 };
    const step: string = mod.export_step(JSON.stringify({ solids: [wall, cyl], fileName: "t.stp" }));
    const back = JSON.parse(mod.import_step(step, 0.0005)) as Array<{ positions: number[]; indices: number[] }>;
    expect(back).toHaveLength(2);
    const vols = back.map(volume).sort((a, b) => a - b);
    expect(vols[0]).toBeCloseTo((5 * 2.6 - 1.2 * 1.2) * 0.3, 1); // Wand
    expect(vols[1]).toBeCloseTo(Math.PI * 2, 1); // Zylinder
  }, 120_000); // Einlesen (Tessellieren) dauert im --no-opt-WASM ~12 s; unter Last ein Vielfaches

  it("Kennwerte + Kollision (truck-meshalgo)", () => {
    const cub = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({ kind: "cuboid", min: [x0, y0, z0], max: [x1, y1, z1] });
    const p = JSON.parse(mod.solid_props(JSON.stringify({ spec: cub(0, 0, 0, 2, 1, 3) })));
    expect(p.volume).toBeCloseTo(6, 6);
    expect(p.area).toBeCloseTo(22, 6);
    expect(p.closed).toBe(true);
    const c = JSON.parse(mod.solid_clash(JSON.stringify({ a: cub(0, 0, 0, 2, 1, 3), b: cub(1, 0.5, 1, 3, 2, 2) })));
    expect(c.colliding).toBe(true);
    expect(c.overlap_volume).toBeCloseTo(0.5, 5);
    const far = JSON.parse(mod.solid_clash(JSON.stringify({ a: cub(0, 0, 0, 1, 1, 1), b: cub(5, 5, 5, 6, 6, 6) })));
    expect(far.colliding).toBe(false);
  }, 30_000);
});
