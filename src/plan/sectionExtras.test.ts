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
  return { id: "t1", type: "terrainMesh", name: "Gelände", positions, indices };
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
      id: "ball", type: "extrudedSolid", levelId: floor.id, height: 2,
      points: [{ x: px - 1, y: pz - 1 }, { x: px + 1, y: pz - 1 }, { x: px + 1, y: pz + 1 }, { x: px - 1, y: pz + 1 }],
      brep: { spec: { kind: "sphere", center: [px, pz, 1], r: 1 }, origin: { x: px - 1, y: pz - 1 } },
    };
    const p: Project = { ...sampleProject, extrudedSolids: [...(sampleProject.extrudedSolids ?? []), sphere] };
    const plan = generateSectionPlan((await computeSection(p, section))!);
    expect(plan.primitives.some((q) => q.kind === "polygon" && q.extrudedSolidId === "ball" && q.fill === "#d9dde2")).toBe(true);
  }, 30_000);
});
