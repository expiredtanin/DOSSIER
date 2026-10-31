// [T6][114] Gelände ausblenden: Kategorie „02 Gelände" (bzw. Elternebene „05 Kontext") schaltet das Terrain
// in Grundriss, Schnitt, Ansicht und 3D ab.
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "./sampleProjectComplex";
import { generatePlan } from "../plan/generatePlan";
import { computeSection, generateSectionPlan } from "../plan/toSection";
import { generateElevationPlan } from "../plan/toElevation";
import { projectToModel3d } from "../plan/toWalls3d";
import { collectVisibleCodes, setCategoriesVisible } from "./layers";

const p = buildComplexSampleProject();
const TERRAIN_ID = p.context!.find((c) => c.type === "terrainMesh")!.id;

const withHidden = (...codes: string[]) => ({ ...p, layers: setCategoriesVisible(p.layers, new Set(codes), false) });
const count = (pl: { primitives: unknown[] }, cls: string) => pl.primitives.filter((q) => (q as { cls?: string }).cls === cls).length;

async function probe(proj: typeof p) {
  const codes = collectVisibleCodes(proj.layers);
  const ug = generatePlan(proj, "ug", codes, undefined, "mittel", false, true, true, 100);
  const sec = await computeSection(proj, proj.drawingLevels.find((l) => l.id === "schnitt-a")!);
  const sp = generateSectionPlan(sec!, false, { visibleCodes: codes, hiddenLines: true, openings: true, scaleDenominator: 100 });
  const ep = generateElevationPlan(proj, proj.drawingLevels.find((l) => l.id === "ansicht-sued")!, { visibleCodes: codes, scaleDenominator: 100 })!;
  const m = projectToModel3d(proj);
  return {
    planTerrain: ug.primitives.filter((q) => (q as { contextObjectId?: string }).contextObjectId === TERRAIN_ID).length,
    sectionTerrain: count(sp, "section-terrain"),
    elevTerrain: count(ep, "elevation-terrain"),
    meshTerrain: m.meshes.filter((x) => x.kind === "terrain").length,
  };
}

describe("Gelände ausblenden", () => {
  it("sichtbar: Gelände in Plan, Schnitt, Ansicht, 3D", async () => {
    const r = await probe(p);
    expect(r.planTerrain).toBeGreaterThan(0);
    expect(r.sectionTerrain).toBeGreaterThan(0);
    expect(r.elevTerrain).toBeGreaterThan(0);
    expect(r.meshTerrain).toBe(1);
  });
  for (const code of ["02", "05"]) {
    it(`Kategorie ${code} aus: Gelände überall weg`, async () => {
      const r = await probe(withHidden(code));
      expect(r).toEqual({ planTerrain: 0, sectionTerrain: 0, elevTerrain: 0, meshTerrain: 0 });
    });
  }
});
