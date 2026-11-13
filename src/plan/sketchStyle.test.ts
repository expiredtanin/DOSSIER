// [236] Skizzenstil verändert nur Striche: Text, Flächenfüllung und Deckkraft (Schatten, Baumkronen) bleiben wie ohne.
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { collectVisibleCodes } from "../model/types";
import type { Project } from "../model/types";
import { generatePlan } from "./generatePlan";

const base = buildComplexSampleProject();
const codes = collectVisibleCodes(base.layers);
const withSketch = (p: Project, on: boolean): Project => ({ ...p, drawingLevels: p.drawingLevels.map((l) => ({ ...l, sketch: on, shadows: true })) });
const planOf = (p: Project) => generatePlan(p, "eg", codes, undefined, "mittel", false, false, true, 100).primitives;

describe("Skizzenstil lässt Text und Flächen unberührt", () => {
  const off = planOf(withSketch(base, false));
  const on = planOf(withSketch(base, true));
  const key = (q: (typeof off)[number]): string => {
    if (q.kind === "text") return JSON.stringify(["text", q]);
    if (q.kind === "polygon") return JSON.stringify(["polygon", q.pts, q.fill, q.opacity ?? 1, q.hatch?.pattern]);
    return "";
  };
  const keys = (v: typeof off, kind: string) => v.filter((q) => q.kind === kind).map(key).sort();

  it("Text kommt genau einmal, unverschoben", () => {
    expect(off.filter((q) => q.kind === "text").length).toBeGreaterThan(5);
    expect(keys(on, "text")).toEqual(keys(off, "text"));
  });

  it("Flächen behalten Füllung und Deckkraft; Schatten bleiben durchscheinend", () => {
    expect(keys(on, "polygon")).toEqual(keys(off, "polygon"));
    expect(off.some((q) => q.kind === "polygon" && q.opacity !== undefined && q.opacity < 1)).toBe(true);
  });
});
