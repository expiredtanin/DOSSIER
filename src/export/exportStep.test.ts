import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sampleProject } from "../model/sampleProject";
import { projectSolidSpecs, wallProfile } from "./exportStep";

describe("wallProfile", () => {
  it("Fenster im Inneren wird zum Loch, Tür am Wandfuss zur Kerbe im Aussenring", () => {
    const p = wallProfile(5, 2.6, [
      { from: 1, to: 2.2, zBottom: 0.9, zTop: 2.1 }, // Fenster
      { from: 3, to: 3.9, zBottom: 0, zTop: 2.1 }, // Tür
    ], 0);
    expect(p.holes).toHaveLength(1);
    expect(p.holes[0]).toEqual([1, 0.9, 2.2, 0.9, 2.2, 2.1, 1, 2.1]);
    // Aussenring: Start, Kerbe (4 Punkte), Ecken rechts/oben
    expect(p.outer).toEqual([0, 0, 3, 0, 3, 2.1, 3.9, 2.1, 3.9, 0, 5, 0, 5, 2.6, 0, 2.6]);
  });

  it("überlappende Kerben werden zusammengefasst, Öffnungen ausserhalb der Wand geklemmt", () => {
    const p = wallProfile(4, 2.5, [
      { from: 1, to: 2, zBottom: 0, zTop: 2 },
      { from: 1.8, to: 3, zBottom: 0, zTop: 2.2 },
      { from: 3.9, to: 6, zBottom: 0, zTop: 2 },
    ], 0);
    expect(p.outer.slice(0, 10)).toEqual([0, 0, 1, 0, 1, 2.2, 3, 2.2, 3, 0]);
  });

  it("Öffnung bis zum Wandkopf wird um 1 mm gekappt (kein Randkontakt)", () => {
    const p = wallProfile(5, 2.6, [{ from: 1, to: 2, zBottom: 1, zTop: 2.6 }], 0);
    expect(p.holes[0][5]).toBeCloseTo(2.599, 6);
  });
});

describe("projectSolidSpecs", () => {
  it("Demo-Haus liefert Wände, Decke, Dach und Treppe als B-Rep-Spezifikationen", () => {
    const specs = projectSolidSpecs(sampleProject);
    const kinds = specs.reduce<Record<string, number>>((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {});
    expect(kinds.extrudePlane).toBeGreaterThan(10); // Wandlagen + Dachflächen
    expect(kinds.extrude).toBeGreaterThan(0); // Decke + Tritte
  });
});

describe("STEP-Export Ende-zu-Ende (truck-WASM)", () => {
  it("Demo-Haus → STEP-Text → wieder einlesbar, ISO-Kopf, Körper vorhanden", async () => {
    const mod: any = await import("../engine/pkgTruck/trucksolid.js");
    await mod.default({ module_or_path: readFileSync("src/engine/pkgTruck/trucksolid_bg.wasm") });
    const specs = projectSolidSpecs(sampleProject);
    const step: string = mod.export_step(JSON.stringify({ solids: specs, fileName: "demo.stp" }));
    expect(step.startsWith("ISO-10303-21;")).toBe(true);
    const back = JSON.parse(mod.import_step(step, 0.002)) as Array<{ positions: number[]; indices: number[] }>;
    expect(back.length).toBeGreaterThan(5);
    expect(back.every((m) => m.indices.length >= 12)).toBe(true);
  }, 60_000);

  it("Abzugskörper: Wandschichten werden boolesch geschnitten (Volumen kleiner), STEP bleibt gültig", async () => {
    const mod: any = await import("../engine/pkgTruck/trucksolid.js");
    await mod.default({ module_or_path: readFileSync("src/engine/pkgTruck/trucksolid_bg.wasm") });
    const w = sampleProject.walls[0];
    const mx = (w.start.x + w.end.x) / 2;
    const my = (w.start.y + w.end.y) / 2;
    const p = {
      ...sampleProject,
      extrudedSolids: [{
        id: "v", type: "extrudedSolid" as const, levelId: w.floorId, operation: "subtract" as const, height: 0.8, baseOffset: 0.5,
        points: [{ x: mx - 0.3, y: my - 1 }, { x: mx + 0.3, y: my - 1 }, { x: mx + 0.3, y: my + 1 }, { x: mx - 0.3, y: my + 1 }],
      }],
    };
    const specs = projectSolidSpecs(p);
    const bools = specs.filter((s) => s.kind === "boolean");
    expect(bools.length).toBeGreaterThan(0);
    const vol = (spec: unknown) => JSON.parse(mod.solid_props(JSON.stringify({ spec }))).volume as number;
    const b0 = bools[0] as { a: unknown };
    expect(vol(bools[0])).toBeLessThan(vol(b0.a) - 1e-4);
    const step: string = mod.export_step(JSON.stringify({ solids: bools, fileName: "void.stp" }));
    expect(step.startsWith("ISO-10303-21;")).toBe(true);
  }, 60_000);
});
