/**
 * [266] 3D-Dokument (Fassade `toAxo.ts` → Kern `plan/axo.rs`): Vorgaben, Kamera, Ausschnitt auf dem Blatt,
 * Klassen-Sichtbarkeit; die Geometrie (verdeckte Kanten, Silhouette, Tönung) prüft der Kern selbst.
 */

import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { ViewSnapshot } from "../model/types";
import { generateAxoPlan, snapshotAxoPlan } from "./toAxo";
import { viewportSnapshotPlan } from "./viewportPlan";

const lines = (p: ReturnType<typeof generateAxoPlan>) => (p?.primitives ?? []).filter((q) => q.kind === "line");

describe("toAxo", () => {
  it("Vorgaben liefern Linien (Silhouette kräftiger) und getönte Flächen mit Pick-Id", () => {
    for (const view of ["southeast", "southwest", "northeast", "northwest"]) {
      const plan = generateAxoPlan(sampleProject, { view })!;
      expect(plan, view).not.toBeNull();
      const ls = lines(plan);
      const outline = ls.filter((q) => q.kind === "line" && q.cls === "axo-outline");
      const edge = ls.filter((q) => q.kind === "line" && q.cls === "axo-edge");
      expect(outline.length).toBeGreaterThan(4);
      expect(edge.length).toBeGreaterThan(4);
      expect(Math.min(...outline.map((q) => (q.kind === "line" ? q.weightMm : 0)))).toBeGreaterThan(Math.max(...edge.map((q) => (q.kind === "line" ? q.weightMm : 0))));
      expect(plan.primitives.some((q) => q.kind === "polygon" && !!q.wallId)).toBe(true);
    }
    // Südost und Nordwest zeigen verschiedene Seiten (andere Zeichnung).
    const se = generateAxoPlan(sampleProject, { view: "southeast" })!;
    const nw = generateAxoPlan(sampleProject, { view: "northwest" })!;
    expect(lines(se).length === lines(nw).length && JSON.stringify(lines(se)) === JSON.stringify(lines(nw))).toBe(false);
  });

  it("Kamera der 3D-Ansicht (Parallel und Perspektive), unbrauchbare Kamera ohne Bild", () => {
    const camera = { kind: "perspective", position: [25, -20, 15] as [number, number, number], direction: [-0.6, 0.6, -0.4] as [number, number, number], up: [0, 0, 1] as [number, number, number], fovDeg: 45 };
    expect(lines(generateAxoPlan(sampleProject, { camera })).length).toBeGreaterThan(10);
    expect(lines(generateAxoPlan(sampleProject, { camera: { ...camera, kind: "orthogonal" } })).length).toBeGreaterThan(10);
    expect(generateAxoPlan(sampleProject, { camera: { ...camera, direction: [0, 0, 0] } })).toBeNull();
    expect(generateAxoPlan(sampleProject, { camera: { ...camera, position: [Number.NaN, 0, 0] } })).toBeNull();
  });

  it("ausgeblendete Klassen nehmen nicht teil", () => {
    expect(generateAxoPlan(sampleProject, { view: "southeast", visibleCodes: new Set() })).toBeNull();
  });

  it("3D-Ausschnitt auf dem Blatt: das 3D-Dokument statt eines Grundrisses", async () => {
    const codes = Object.fromEntries((sampleProject.layers ?? []).map((l) => [l.code, true]));
    const snap: ViewSnapshot = { id: "s3d", name: "3D", viewType: "perspektive", view3d: "isoBackRight", scaleDenominator: 100, detail: "mittel", activeLevelId: sampleProject.drawingLevels[0].id, layerVisibility: codes, drawingVisibility: {}, doc3d: { projection: "military" } };
    const plan = await viewportSnapshotPlan(sampleProject, snap, new Set(Object.keys(codes)), 100);
    expect(plan.primitives.some((q) => q.kind === "line" && q.cls === "axo-outline")).toBe(true);
    expect(JSON.stringify(plan.primitives.slice(0, 50))).toBe(JSON.stringify(snapshotAxoPlan(sampleProject, snap, new Set(Object.keys(codes)), 100)!.primitives.slice(0, 50)));
  });

});
