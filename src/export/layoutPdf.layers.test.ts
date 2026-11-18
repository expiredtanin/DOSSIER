// [282] PDF-Ebenen: die Stapelung (Zeichenreihenfolge) des ganzen Plans bleibt erhalten. Befund: Decken-Füllung
// (Kategorie 30, im Plan UNTER den Wänden) lag als Ebene nach „Wände" (20) und deckte sie im Erdgeschoss weiss zu.
import { describe, expect, it } from "vitest";
import { buildWettbewerbSampleProject } from "../model/sampleProjectWettbewerb";
import { visibleCodesFromSnapshot } from "../model/layoutModel";
import { getState } from "../state/appStore";
import { presentationDefaults, presentationSheetOps } from "../plan/presentationSheet";
import { viewportSnapshotPlan } from "../plan/viewportPlan";
import type { Plan } from "../plan/generatePlan";
import { categoryLayerGroups, layerRunsInPlanOrder } from "./pdfLayers";

const LABELS = { sheetName: "P", masterName: "M", north: "N", northGroup: "N", scaleBarGroup: "S", situation: "S", tableAreas: "A", tableSiteProof: "B", imagePlaceholder: "I", imageHint: "H" };

const poly = (x: number): Plan["primitives"][number] =>
  ({ kind: "polygon", pts: [{ x, y: 0 }, { x: x + 1, y: 0 }, { x: x + 1, y: 1 }], fill: "#fff", stroke: "#000", strokeWidthMm: 0.1, hatch: {} }) as never;

describe("layerRunsInPlanOrder", () => {
  it("bildet Läufe in der Reihenfolge des ganzen Plans (Decke zuerst, dann Wand, dann Raum)", () => {
    const [d, w, r] = [poly(1), poly(2), poly(3)];
    const b = { minX: 0, minY: 0, maxX: 5, maxY: 5 };
    const full: Plan = { primitives: [d, w, r], bounds: b };
    const groups: { name: string; plan: Plan }[] = [
      { name: "Wände", plan: { primitives: [w], bounds: b } },
      { name: "Decken", plan: { primitives: [d], bounds: b } },
      { name: "Räume", plan: { primitives: [r], bounds: b } },
    ];
    expect(layerRunsInPlanOrder(full, groups).map((x) => x.name)).toEqual(["Decken", "Wände", "Räume"]);
  });

  it("verschränkte Gruppen ergeben mehrere Läufe, nichts geht verloren oder doppelt", () => {
    const p = [poly(1), poly(2), poly(3), poly(4)];
    const b = { minX: 0, minY: 0, maxX: 5, maxY: 5 };
    const groups: { name: string; plan: Plan }[] = [
      { name: "A", plan: { primitives: [p[0], p[2]], bounds: b } },
      { name: "B", plan: { primitives: [p[1], p[3]], bounds: b } },
    ];
    const full: Plan = { primitives: p, bounds: b };
    const runs = layerRunsInPlanOrder(full, groups);
    expect(runs.map((x) => x.name)).toEqual(["A", "B", "A", "B"]);
    expect(runs.flatMap((x) => x.primitives)).toEqual(p);
  });
});

describe("[282] Wettbewerb Präsentationsplan", () => {
  it("Erdgeschoss: Läufe enthalten alle Primitive des ganzen Plans, Wände nach den Decken", async () => {
    getState().loadProject(buildWettbewerbSampleProject());
    const p0 = getState().project;
    const res = presentationSheetOps(p0, { ...presentationDefaults(p0), scale: 200 }, LABELS as never, "t282")!;
    getState().applyChange(res.ops);
    const p = getState().project;
    const lay = p.layouts!.find((l) => l.id === res.layoutId)!;
    const vp = lay.viewports.find((v) => p.viewSnapshots!.find((s) => s.id === v.snapshotId)!.activeLevelId === "eg")!;
    const snap = p.viewSnapshots!.find((s) => s.id === vp.snapshotId)!;
    const codes = visibleCodesFromSnapshot(snap);
    const full = await viewportSnapshotPlan(p, snap, codes, 200, true, vp);
    const groups: { name: string; plan: Plan }[] = [];
    for (const g of categoryLayerGroups(p.layers, codes, "x")) groups.push({ name: g.name, plan: await viewportSnapshotPlan(p, snap, g.codes, 200, true, vp) });
    const runs = layerRunsInPlanOrder(full, groups);
    expect(runs.flatMap((r) => r.primitives).length).toBe(full.primitives.length);
    const idx = (n: string) => runs.findIndex((r) => r.name === n && r.primitives.some((q) => "wallId" in q && q.wallId));
    const ceil = runs.findIndex((r) => r.primitives.some((q) => "ceilingId" in q && q.ceilingId));
    expect(idx("Wände")).toBeGreaterThanOrEqual(0);
    expect(ceil).toBeGreaterThanOrEqual(0);
    expect(ceil).toBeLessThan(idx("Wände"));
  }, 120_000);
});
