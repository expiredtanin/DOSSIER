// Gelände und freie Körper im Schnitt ([G1]): echter Lauf über computeSection/generateSectionPlan
// (Kern, truck-WASM aus src/engine/pkgTruck).
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setWasmBytesProvider } from "../engine/wasmSource";
import { computeSection, generateSectionPlan } from "./toSection";
import { sampleProject } from "../model/sampleProject";
import type { ExtrudedSolid, Project, TerrainMesh } from "../model/types";

beforeAll(() => {
  setWasmBytesProvider(async (name) =>
    readFileSync(join(process.cwd(), "src", "engine", name === "trucksolid" ? "pkgTruck/trucksolid_bg.wasm" : "pkg3d/render3d_bg.wasm")),
  );
});

const section = sampleProject.drawingLevels.find((l) => l.kind === "section")!;

/** Gelände: Raster 41×41 über −20…+20 m, z = 0.1·x (geneigt). */
function terrain(): TerrainMesh {
  const n = 41;
  const positions: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) positions.push(i - 20, j - 20, 0.1 * (i - 20));
  const indices: number[] = [];
  for (let j = 0; j + 1 < n; j++)
    for (let i = 0; i + 1 < n; i++) {
      const a = j * n + i;
      indices.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
    }
  return { id: "t1", type: "terrainMesh", categoryCode: "02", name: "Gelände", positions, indices };
}

describe("Schnitt: Gelände und freie Körper", () => {
  it("Geländelinie als Linienzug im Schnitt, auf den Gebäudebereich begrenzt", async () => {
    const p: Project = { ...sampleProject, context: [...(sampleProject.context ?? []), terrain()] };
    const plan = generateSectionPlan((await computeSection(p, section))!);
    const terrainLines = plan.primitives.filter((q) => q.kind === "line" && q.cls === "section-terrain");
    expect(terrainLines.length).toBeGreaterThan(0);
    const us = terrainLines.flatMap((q) => (q.kind === "line" ? [q.a.x, q.b.x] : []));
    // Begrenzung: nicht über das ganze 40-m-Gelände, sondern Inhalt ± Rand
    const cut = plan.primitives.flatMap((q) =>
      q.kind === "polygon" ? q.pts.map((r) => r.x) : q.kind === "line" && q.cls === "section-visible" ? [q.a.x, q.b.x] : [],
    );
    expect(Math.min(...us)).toBeGreaterThanOrEqual(Math.min(...cut) - 6.01);
    expect(Math.max(...us)).toBeLessThanOrEqual(Math.max(...cut) + 6.01);
  }, 30_000);

  it("Kugel (B-Rep) wird als Schnittfläche gefüllt, wenn die Ebene sie trifft", async () => {
    const floor = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
    // Kugel mitten auf der Schnittebene: Position aus der Schnittlinie des Beispiels
    const [px, , pz] = (await import("./toSection")).sectionPlaneFromLevel(section)!.point;
    const sphere: ExtrudedSolid = {
      id: "ball", type: "extrudedSolid", categoryCode: "20", levelId: floor.id, height: 2,
      points: [{ x: px - 1, y: pz - 1 }, { x: px + 1, y: pz - 1 }, { x: px + 1, y: pz + 1 }, { x: px - 1, y: pz + 1 }],
      brep: { spec: { kind: "sphere", center: [px, pz, 1], r: 1 }, origin: { x: px - 1, y: pz - 1 } },
    };
    const p: Project = { ...sampleProject, extrudedSolids: [...(sampleProject.extrudedSolids ?? []), sphere] };
    // 1:50 (ab 1:100 sind Schnittflächen schwarz, [140])
    const plan = generateSectionPlan((await computeSection(p, section))!, false, { scaleDenominator: 50 });
    expect(plan.primitives.some((q) => q.kind === "polygon" && q.extrudedSolidId === "ball" && q.fill === "#d9dde2")).toBe(true);
  }, 30_000);

  it("Abzugskörper beliebiger Form (Kugel, B-Rep) spart die Schnittflächen aus, ohne selbst zu erscheinen", async () => {
    const floor = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
    const [a, b] = section.linePoints!;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const r = 2;
    const ball: ExtrudedSolid = {
      id: "void-ball", type: "extrudedSolid", categoryCode: "20", levelId: floor.id, height: 2 * r, operation: "subtract",
      points: [{ x: cx - r, y: cy - r }, { x: cx + r, y: cy - r }, { x: cx + r, y: cy + r }, { x: cx - r, y: cy + r }],
      brep: { spec: { kind: "sphere", center: [cx, cy, 1], r }, origin: { x: cx - r, y: cy - r } },
    };
    const cutArea = async (p: Project) => {
      const plan = generateSectionPlan((await computeSection(p, section))!);
      expect(plan.primitives.some((q) => q.kind === "polygon" && q.extrudedSolidId === "void-ball")).toBe(false);
      return plan.primitives.reduce((s, q) => {
        if (q.kind !== "polygon" || q.fill === "none") return s;
        const n = q.pts.length;
        return s + Math.abs(q.pts.reduce((t, v, i) => t + v.x * q.pts[(i + 1) % n].y - q.pts[(i + 1) % n].x * v.y, 0)) / 2;
      }, 0);
    };
    const before = await cutArea(sampleProject);
    const after = await cutArea({ ...sampleProject, extrudedSolids: [...(sampleProject.extrudedSolids ?? []), ball] });
    expect(after).toBeLessThan(before - 0.1);
  }, 30_000);
});
