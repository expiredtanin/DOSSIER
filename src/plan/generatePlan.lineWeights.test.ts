/**
 * [32] Strichstärken nach Massstab: Faktor (100/n)^0.25 auf alle Papier-mm-Stärken des Grundrisses,
 * nur mit `Project.scaleLineWeights`.
 */

import { describe, expect, it } from "vitest";
import { generatePlan, materializeUnderlay } from "./generatePlan";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories } from "../model/types";
import type { Project } from "../model/types";
import type { Primitive } from "./generatePlan/shared";

const ALL = new Set(flattenCategories(sampleProject.layers).map((c) => c.code));
const on: Project = { ...sampleProject, scaleLineWeights: true };
const weights = (ps: Primitive[]) =>
  ps.flatMap((p) => (p.kind === "polygon" ? [p.strokeWidthMm] : "weightMm" in p && typeof p.weightMm === "number" ? [p.weightMm] : []));
const plan = (p: Project, n: number, compact = false) =>
  materializeUnderlay(generatePlan(p, "eg", ALL, undefined, "mittel", false, false, true, n, false, compact));

describe("Strichstärken nach Massstab", () => {
  // Der Faktor selbst (Grenzen, ungültiger Massstab) ist im Kern geprüft (`plan/extras.rs`).
  it("Grundriss 1:200: jede Stärke × Faktor, aus → unverändert", () => {
    const base = weights(plan(sampleProject, 200).primitives);
    const scaled = weights(plan(on, 200).primitives);
    expect(scaled.length).toBe(base.length);
    const f = 0.5 ** 0.25;
    scaled.forEach((w, i) => expect(w).toBeCloseTo(base[i] * f, 9));
  });
  it("auch die kompakte Linien-Unterlage (GPU-Ansicht) wird skaliert", () => {
    const base = weights(plan(sampleProject, 200, true).primitives);
    const scaled = weights(plan(on, 200, true).primitives);
    expect(scaled.length).toBe(base.length);
    scaled.forEach((w, i) => expect(w).toBeCloseTo(base[i] * 0.5 ** 0.25, 9));
  });
  it("gleiche Eingabe → gleiche Inhalts-Hashes der Kern-Abschnitte (GPU-Cache), auch mit Massstab", () => {
    const line = {
      id: "z1", type: "drawing2d", levelId: "eg", categoryCode: sampleProject.drawings2d[0]?.categoryCode ?? sampleProject.layers[0].code,
      geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }], closed: false },
    } as Project["drawings2d"][number];
    const hashes = (p: Project) => {
      const pl = generatePlan(p, "eg", ALL, undefined, "mittel", false, false, true, 200);
      return (pl.bufRuns ?? []).flatMap((r) => Array.from(r.buf.hashes!.subarray(r.from, r.to)));
    };
    const base = { ...sampleProject, drawings2d: [...sampleProject.drawings2d, line] };
    const a = hashes(base);
    expect(a.length).toBeGreaterThan(0);
    expect(hashes(base)).toEqual(a);
    // Der Strichstärken-Massstab rechnet der Kern in den Puffer: andere Stärken, andere Hashes.
    const scaled = hashes({ ...on, drawings2d: base.drawings2d });
    expect(scaled.length).toBe(a.length);
    expect(scaled).not.toEqual(a);
  });
});
