// STEP-Import Ende-zu-Ende: truck liest (flacher Puffer) → der Kern macht Kontext-Meshes, ein Undo-Schritt.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sampleProject } from "../model/sampleProject";
import { documentFor } from "../core/document";
import type { ImportedMesh, Project } from "../model/types";

const STEP_BOX = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({
  kind: "cuboid",
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});

const stripCode10 = (ls: Project["layers"]): Project["layers"] =>
  ls.filter((l) => l.code !== "10").map((l) => (l.children ? { ...l, children: stripCode10(l.children) } : l));

describe("STEP-Import im Kern", () => {
  it("zwei Körper → zwei Kontext-Meshes, Kategorie ergänzt, ein Undo-Schritt", async () => {
    const mod: any = await import("../engine/pkgTruck/trucksolid.js");
    await mod.default({ module_or_path: readFileSync("src/engine/pkgTruck/trucksolid_bg.wasm") });
    const step: string = mod.export_step(
      JSON.stringify({ solids: [STEP_BOX(0, 0, 0, 2, 1, 3), STEP_BOX(5, 0, 0, 6, 1, 1)], fileName: "k.stp" }),
    );
    const flat: Float64Array = mod.import_step_flat(step, 0.0005);

    const base = { ...sampleProject, context: undefined, layers: stripCode10(sampleProject.layers) };
    const doc = documentFor(base);
    const r = doc.importStep(base, flat, { fileName: "Haus.stp" }, 1.7e12);
    expect("problems" in r).toBe(false);
    if ("problems" in r) return;
    expect(r.contextObjects).toBe(2);
    const ctx = (r.project.context ?? []) as ImportedMesh[];
    expect(ctx.map((m) => m.name)).toEqual(["Haus (1/2)", "Haus (2/2)"]);
    expect(ctx.every((m) => m.categoryCode === "10" && m.id.startsWith("imported-step-"))).toBe(true);
    expect(ctx[0].indices.length).toBe(36);
    expect(Math.max(...ctx[0].positions.filter((_, i) => i % 3 === 0))).toBeCloseTo(2, 5);
    expect(JSON.stringify(r.project.layers)).toContain('"code":"10"');
    expect(JSON.stringify(base.layers)).not.toContain('"code":"10"');
    // ein Undo-Schritt stellt das Projekt wieder her
    expect(doc.historyState().undo).toBe(1);
    const back = doc.undo(r.project);
    expect(back?.context ?? []).toEqual([]);
    expect(back?.layers).toEqual(base.layers);
  }, 120_000);

  it("kaputter Puffer wird abgewiesen", () => {
    const doc = documentFor(sampleProject);
    expect(() => doc.importStep(sampleProject, new Float64Array([1, 3]), { fileName: "x.stp" }, 1)).toThrow(/Puffer/);
  });
});
