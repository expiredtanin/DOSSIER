// [82] Legende → Plan: Schraffur-Muster kommen vom Kern-Generator, Namen als Text, live mit dem Projekt.

import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Layout, Project, ViewSnapshot } from "../model/types";
import { legendPlan } from "./legendSvg";

function proj(): Project {
  const snap = {
    id: "s1",
    name: "EG",
    activeLevelId: "eg",
    layerVisibility: Object.fromEntries(sampleProject.layers.map((c) => [c.code, true])),
  } as unknown as ViewSnapshot;
  const layout: Layout = {
    id: "l1",
    name: "Blatt",
    paper: "a3",
    orientation: "landscape",
    viewports: [{ id: "v1", snapshotId: "s1", xMm: 10, yMm: 10, widthMm: 200, heightMm: 150 }],
  };
  return { ...sampleProject, viewSnapshots: [snap], layouts: [layout] };
}

describe("legendPlan", () => {
  it("enthält je Material eine geschraffte Fläche und den Namen, im Legende-Rahmen", () => {
    const p = proj();
    const lp = legendPlan(p, p.layouts![0], { id: "g", xMm: 20, yMm: 30, title: "Legende" })!;
    const polys = lp.plan.primitives.filter((x) => x.kind === "polygon");
    expect(polys.length).toBeGreaterThanOrEqual(1 + 6); // Rahmen + 6 Materialien der Aussenwand/Decke
    expect(polys.filter((x) => x.kind === "polygon" && x.hatch.pattern !== "none").length).toBeGreaterThanOrEqual(4);
    const names = JSON.stringify(lp.plan.primitives);
    for (const c of p.components.filter((c) => ["brick", "insulation", "concrete"].includes(c.id))) expect(names).toContain(c.name);
    expect(lp.widthMm).toBeGreaterThan(20);
    // Live: andere Wandart → andere Einträge.
    const q: Project = { ...p, walls: [] };
    const lq = legendPlan(q, q.layouts![0], { id: "g", xMm: 20, yMm: 30 })!;
    expect(lq.heightMm).toBeLessThan(lp.heightMm);
  });
});
