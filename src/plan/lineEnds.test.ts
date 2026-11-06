/**
 * [146] Linienenden und -ecken: eine Projekt-Einstellung (`lineCap`/`lineJoin`), Standard flach +
 * Gehrung. Sie reist als `Plan.lineEnds` in alle Ausgabewege: render2d-Szene (Kopfwort), Plan-SVG
 * (`<g>`), GPU-Chunks (`BufferGl.lineEnds`).
 */

import { describe, expect, it } from "vitest";
import { generatePlan } from "./generatePlan";
import { planSceneBin } from "./toRenderScene";
import { planToSvgString } from "../export/planToSvgString";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories, type Project } from "../model/types";
import { lineEndsCode, lineEndsFromCode, lineEndsOf, lineEndsSvgAttrs } from "../model/lineEnds";
import { GpuChunkCache } from "./glPlan/glPlanChunks";
import type { BufferGl } from "./glPlan/glPlanTypes";

const ALL = new Set(flattenCategories(sampleProject.layers).map((c) => c.code));
const floor = sampleProject.drawingLevels.find((l) => l.kind === "floor")!.id;
const planOf = (p: Project) => generatePlan(p, floor, ALL);

describe("[146] Linienenden und -ecken", () => {
  it("Kodierung: fehlt = flach + Gehrung, Rundreise, Unsinn = Standard", () => {
    expect(lineEndsOf({})).toEqual({ cap: "butt", join: "miter" });
    expect(lineEndsCode({})).toBe(0);
    expect(lineEndsCode({ lineCap: "square", lineJoin: "bevel" })).toBe(2 | (2 << 2));
    expect(lineEndsFromCode(1 | (1 << 2))).toEqual({ cap: "round", join: "round" });
    expect(lineEndsFromCode(Number.NaN)).toEqual({ cap: "butt", join: "miter" });
    expect(lineEndsSvgAttrs(0)).toEqual({ "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4" });
  });

  it("Plan trägt die Einstellung; Plan-SVG und render2d-Szene übernehmen sie", () => {
    const std = planOf(sampleProject);
    expect(std.lineEnds).toBe(0);
    const round = planOf({ ...sampleProject, lineCap: "round", lineJoin: "bevel" });
    expect(round.lineEnds).toBe(1 | (2 << 2));

    const svg0 = planToSvgString(std, { scaleDenominator: 100 });
    expect(svg0).toContain('<g stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="4">');
    // Volle Linien tragen keine eigene Kappe mehr (nur Punkt-Muster runden selbst).
    expect(svg0).not.toMatch(/<line [^>]*stroke-linecap="round"(?![^>]*stroke-dasharray)/);
    const svg1 = planToSvgString(round, { scaleDenominator: 100 });
    expect(svg1).toContain('<g stroke-linecap="round" stroke-linejoin="bevel"');

    const head = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(44, true);
    expect(head(planSceneBin(std))).toBe(0);
    expect(head(planSceneBin(round))).toBe(1 | (2 << 2));
  });

  it("GPU-Chunks: Wechsel der Einstellung verwirft die Chunks und kompiliert mit ihr", () => {
    const uploads: number[] = [];
    const gl: BufferGl = {
      packedLineVertices: true,
      ARRAY_BUFFER: 1,
      ELEMENT_ARRAY_BUFFER: 2,
      STATIC_DRAW: 3,
      createBuffer: () => ({}) as WebGLBuffer,
      bindBuffer: () => {},
      bufferData: (_t, data) => void uploads.push(data.byteLength),
      deleteBuffer: () => {},
    };
    const cache = new GpuChunkCache(gl);
    const run = (p: Project) => {
      const plan = planOf(p);
      cache.setLineEnds(plan.lineEnds);
      cache.update(plan.primitives, 0, -Infinity, plan.greyedRanges, plan.underlay, plan.bufRuns);
      return cache.lastStats.recompiled;
    };
    expect(run(sampleProject)).toBeGreaterThan(0);
    expect(run(sampleProject)).toBe(0);
    expect(gl.lineEnds ?? 0).toBe(0);
    expect(run({ ...sampleProject, lineCap: "square" })).toBeGreaterThan(0);
    expect(gl.lineEnds).toBe(2);
  });
});
