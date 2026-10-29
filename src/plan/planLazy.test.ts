// Lazy Plan ([K3d], `planLazy.ts`): `generatePlan` liest die Kern-Primitive erst bei Bedarf; die
// Verbraucher im Kern (Szene, Auswahl, SVG) und die Text-Einträge kommen ohne aus.

import { describe, expect, it } from "vitest";
import { generatePlan, generateVisibleLevelsPlan, materializeUnderlay, type Primitive } from "./generatePlan";
import { isLazyUnread, planCount, planPrimAt, planTextEntries, planWithExtra } from "./planLazy";
import { planSceneBin, planToRenderScene } from "./toRenderScene";
import { planToSvgString } from "../export/planToSvgString";
import { PlanPickIndex } from "./planView/planPick";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories, type Project } from "../model/types";

const codes = (p: Project) => new Set(flattenCategories(p.layers).map((c) => c.code));

const withText: Project = {
  ...sampleProject,
  drawings2d: [
    ...sampleProject.drawings2d,
    { id: "t1", type: "drawing2d", levelId: "eg", categoryCode: "60", geom: { shape: "text", at: { x: 1, y: 2 }, text: "Hallo", height: 0.3, angle: 0 } },
    { id: "l1", type: "drawing2d", levelId: "eg", categoryCode: "60", geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 3, y: 1 } } },
  ] as Project["drawings2d"],
};

describe("lazy Plan", () => {
  it("Verbraucher im Kern lesen die Primitive nicht", () => {
    const plan = generatePlan(withText, "eg", codes(withText));
    expect(isLazyUnread(plan)).toBe(true);
    planSceneBin(plan);
    planToRenderScene(plan);
    planToSvgString(plan);
    const ix = new PlanPickIndex(plan);
    ix.topPolygon({ x: 2, y: 2 });
    ix.marquee("wallId", { minX: -100, minY: -100, maxX: 100, maxY: 100 }, false);
    ix.drawingTextAt({ x: 1.2, y: 2 });
    ix.release();
    expect(planTextEntries(plan).length).toBeGreaterThan(0);
    expect(planPrimAt(plan, 0)).toBeDefined();
    expect(isLazyUnread(plan)).toBe(true);
  });

  it("Einzelzugriff, Text-Einträge und Anzahl == gelesene Liste (dieselben Objekte)", () => {
    for (const l of ["eg", "og"]) {
      const plan = generatePlan(withText, l, codes(withText));
      const n = planCount(plan);
      const single = Array.from({ length: n }, (_, i) => planPrimAt(plan, i));
      const texts = planTextEntries(plan);
      expect(plan.primitives.length).toBe(n);
      single.forEach((p, i) => expect(p).toBe(plan.primitives[i]));
      const want = plan.primitives
        .map((p, i) => ({ p, i }))
        .filter((e) => e.p.kind === "text" || e.p.kind === "drawingText" || e.p.kind === "drawingTextPath" || e.p.kind === "drawingImage");
      expect(texts.map((e) => e.i)).toEqual(want.map((e) => e.i));
      texts.forEach((e, k) => expect(e.p).toBe(want[k].p));
      expect(planPrimAt(plan, n)).toBeUndefined();
    }
  });

  it("Überlagerung, kompakte Unterlage und Anhängen bleiben lazy und gleich", () => {
    const plan = generateVisibleLevelsPlan(withText, "og", codes(withText), undefined, "mittel", false, false, undefined, 100, true);
    expect(isLazyUnread(plan)).toBe(true);
    const mat = materializeUnderlay(plan);
    const extra: Primitive = { kind: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, cls: "x", weightMm: 0.1 };
    const ext = planWithExtra(mat, [extra], [extra]);
    expect(isLazyUnread(mat) && isLazyUnread(ext)).toBe(true);
    expect(ext.primitives).toEqual([extra, ...mat.primitives, extra]);
    expect(ext.greyedRanges).toEqual(mat.greyedRanges?.map(([a, b]) => [a + 1, b + 1]));
    // Eager zum Vergleich: dieselbe Liste wie die gelesene.
    expect(plan.primitives.length).toBe(planCount(plan));
  });

  it("Mono bleibt eine gewöhnliche Liste", () => {
    const plan = generatePlan(sampleProject, "eg", codes(sampleProject), undefined, "mittel", false, true);
    expect(isLazyUnread(plan)).toBe(false);
  });
});
