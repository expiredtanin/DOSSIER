// Render-Szene aus dem Kern ([K3d], `core/src/plan_scene.rs`): Verkettung der 2D-Zeichenlinien,
// Kantennaht über Polygon-Grenzen, gedimmte Bereiche ohne Klonen, Binärszene passt zur
// Objekt-Szene, verdrängte Puffer werden neu abgelegt. (Bitgleich zur früheren TS-Fassung
// geprüft: Beispielprojekt, 400 Zufallslisten, grosses Projekt — s. TODO [K3d].)

import { describe, expect, it } from "vitest";
import { planSceneBin, planToRenderScene } from "./toRenderScene";
import { generatePlan, generateVisibleLevelsPlan, materializeGreyed, materializeUnderlay } from "./generatePlan";
import type { Primitive } from "./generatePlan";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories } from "../model/types";
import { planOf, randomPrims } from "./randomPrims.testing";
import { planParts } from "./planParts";
import { core } from "../engine/coreWasm";

const codes = new Set(flattenCategories(sampleProject.layers).map((c) => c.code));

const line = (ax: number, ay: number, bx: number, by: number, extra: Partial<Primitive> = {}): Primitive =>
  ({ kind: "line", a: { x: ax, y: ay }, b: { x: bx, y: by }, cls: "draw2d", weightMm: 0.25, drawingId: "d", ...extra }) as Primitive;

describe("planToRenderScene (Kern)", () => {
  it("verkettet 2D-Zeichenlinien zu Polylinie bzw. Umriss", () => {
    const open = planToRenderScene(planOf([line(0, 0, 1, 0), line(1, 0, 1, 1), line(5, 5, 6, 6, { drawingId: undefined })]));
    expect(open.polylines.map((p) => p.pts.length)).toEqual([3]);
    expect(open.lines.length).toBe(1);
    const ring = planToRenderScene(planOf([line(0, 0, 1, 0), line(1, 0, 1, 1), line(1, 1, 0, 0)]));
    expect(ring.outlines.map((o) => o.pts.length)).toEqual([3]);
    expect(ring.outlines[0].dash).toBeNull();
  });

  it("näht unterdrückte Kanten zweier Polygone zu einem Ring", () => {
    const a: Primitive = { kind: "polygon", pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], fill: "#eee", stroke: "#000", strokeWidthMm: 0.35, noStrokeEdges: [1] } as Primitive;
    const b: Primitive = { kind: "polygon", pts: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }], fill: "#eee", stroke: "#000", strokeWidthMm: 0.35, noStrokeEdges: [3] } as Primitive;
    const s = planToRenderScene(planOf([a, b]));
    expect(s.fills.length).toBe(2);
    expect(s.outlines.length).toBe(1);
    expect(s.outlines[0].pts.length).toBe(6);
    expect(s.outlines[0].z).toBe(3);
  });

  it("gedimmte Bereiche wirken wie materialisiertes `greyed`", () => {
    for (let seed = 1; seed < 30; seed++) {
      const prims = randomPrims(seed, 40);
      const plan = planOf(prims, [[2, 15], [20, 33]]);
      expect(JSON.stringify(planToRenderScene(plan))).toBe(JSON.stringify(planToRenderScene(materializeGreyed(plan, true))));
      expect(Buffer.from(planSceneBin(plan)).equals(Buffer.from(planSceneBin(materializeGreyed(plan, true))))).toBe(true);
    }
    const over = generateVisibleLevelsPlan(sampleProject, "og", codes, undefined, "mittel", false, false, () => ({ render: true, greyed: true, locked: false }), 100, true);
    const plan = materializeUnderlay(over);
    expect(plan.greyedRanges?.length).toBeGreaterThan(0);
    expect(JSON.stringify(planToRenderScene(plan))).toBe(JSON.stringify(planToRenderScene(materializeGreyed(plan, true))));
  });

  it("Binärszene: Zähler wie die Objekt-Szene", () => {
    const plan = generatePlan(sampleProject, "eg", codes);
    const s = planToRenderScene(plan);
    const b = planSceneBin(plan);
    const h = new Uint32Array(b.buffer, b.byteOffset, 12);
    expect(String.fromCharCode(...b.subarray(0, 4))).toBe("DR2S");
    expect([...h.subarray(1, 8)]).toEqual([1, s.fills.length, s.outlines.length, s.polylines.length, s.arcs.length, s.lines.length, s.texts.length]);
    expect(s.fills.length).toBeGreaterThan(10);
  });

  it("verdrängte Puffer werden neu abgelegt", () => {
    const plan = generatePlan(sampleProject, "eg", codes);
    const before = planSceneBin(plan);
    for (const buf of planParts(plan).bufs) core().plan_buf_release(buf.hold);
    expect(Buffer.from(planSceneBin(plan)).equals(Buffer.from(before))).toBe(true);
  });
});
