/**
 * [212] Materialtabelle des Pathtracers: je Textur-Ebene ({@link wallMaterialColorMaps}) Baustoff-Name und Farbkarte,
 * in derselben Reihenfolge (render3d ordnet `materialIndex` i der Tabelle i − 1 zu). Etappe 4: Normalen-/Rauigkeitskarte,
 * Wiese für Gelände ohne Material, Material des Geländes (`TerrainMesh.componentId`) bis ins 3D und durch die Datei.
 */

import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import type { Project, TerrainMesh } from "../model/types";
import { TERRAIN_GRASS_MATERIAL } from "../materials/terrainMaterial";
import { parseProjectFile, serializeProject } from "../io/projectFormat";
import { pathtraceMaterials, projectToModel3d, wallMaterialColorMaps } from "./toWalls3d";

const sampleProjectComplex = buildComplexSampleProject();

/** Das Beispiel mit dem Bauteil `componentId` am (einzigen) Gelände. */
function withTerrainComponent(p: Project, componentId: string | undefined): Project {
  return { ...p, context: (p.context ?? []).map((o) => (o.type === "terrainMesh" ? { ...o, componentId } : o)) };
}

describe("[212] pathtraceMaterials", () => {
  it("folgt den Textur-Ebenen und nennt den Baustoff", () => {
    const maps = wallMaterialColorMaps(sampleProjectComplex);
    const table = pathtraceMaterials(sampleProjectComplex);
    expect(maps.length).toBeGreaterThan(0);
    // Die Ebenen der Bauteile zuerst, in derselben Reihenfolge; dahinter höchstens die Wiese des Geländes.
    expect(table.slice(0, maps.length).map((e) => e.map)).toEqual(maps);
    for (const e of table.slice(0, maps.length)) {
      const comp = (sampleProjectComplex.components ?? []).find((c) => c.name === e.name);
      expect(comp?.material?.color).toBe(e.map);
    }
  });

  it("gibt die Kachelgrösse der Bildkarte mit (Etappe 3)", () => {
    const table = pathtraceMaterials(sampleProjectComplex).filter((e) => !e.terrain);
    for (const e of table) {
      const comp = (sampleProjectComplex.components ?? []).find((c) => c.material?.color === e.map);
      expect(e.size).toBe(comp?.material?.sizeM);
    }
    expect(table.some((e) => e.size !== undefined)).toBe(true);
  });

  it("Etappe 4: Normalen- und Rauigkeitskarte des Bauteils", () => {
    for (const e of pathtraceMaterials(sampleProjectComplex).filter((x) => !x.terrain)) {
      const mat = (sampleProjectComplex.components ?? []).find((c) => c.material?.color === e.map)?.material;
      expect(e.normal).toBe(mat?.normal);
      expect(e.rough).toBe(mat?.roughness);
    }
  });

  it("Etappe 4: Gelände ohne Material bekommt hinten die Wiese (Grass005, Kachel 4 m)", () => {
    const table = pathtraceMaterials(sampleProjectComplex);
    const maps = wallMaterialColorMaps(sampleProjectComplex);
    expect(table).toHaveLength(maps.length + 1);
    expect(table.at(-1)).toEqual({
      name: "Wiese",
      map: TERRAIN_GRASS_MATERIAL.color,
      size: 4,
      normal: TERRAIN_GRASS_MATERIAL.normal,
      rough: TERRAIN_GRASS_MATERIAL.roughness,
      terrain: true,
    });
    // Ohne Gelände keine Wiese.
    const noTerrain = { ...sampleProjectComplex, context: (sampleProjectComplex.context ?? []).filter((o) => o.type !== "terrainMesh") };
    expect(pathtraceMaterials(noTerrain).some((e) => e.terrain)).toBe(false);
  });

  it("leer ohne Farbkarten (bis auf die Wiese des Geländes)", () => {
    const bare = { ...sampleProjectComplex, components: (sampleProjectComplex.components ?? []).map((c) => ({ ...c, material: undefined })) };
    expect(pathtraceMaterials(bare).map((e) => e.map)).toEqual([TERRAIN_GRASS_MATERIAL.color]);
  });
});

describe("[212] Material des Geländes (TerrainMesh.componentId)", () => {
  const kies = (sampleProjectComplex.components ?? []).find((c) => c.material?.color?.includes("Gravel043"))!;
  const terrainOf = (p: Project) => (p.context ?? []).find((o): o is TerrainMesh => o.type === "terrainMesh")!;

  it("Bauteil mit Bildkarte: Textur-Ebene am Gelände-Netz, keine Wiese", () => {
    expect(kies).toBeDefined();
    const p = withTerrainComponent(sampleProjectComplex, kies.id);
    const maps = wallMaterialColorMaps(p);
    const mesh = projectToModel3d(p).meshes.find((m) => m.kind === "terrain")!;
    expect(mesh.materialIndex).toBe(maps.indexOf(kies.material!.color!) + 1);
    expect(pathtraceMaterials(p).some((e) => e.terrain)).toBe(false);
    // Ohne Bauteil: keine Ebene.
    expect(projectToModel3d(sampleProjectComplex).meshes.find((m) => m.kind === "terrain")!.materialIndex).toBeUndefined();
  });

  it("Rundreise Datei: componentId bleibt, ohne Warnung", () => {
    const p = withTerrainComponent(sampleProjectComplex, kies.id);
    const r = parseProjectFile(serializeProject(p));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(terrainOf(r.project).componentId).toBe(kies.id);
    expect(r.warnings.join(" ")).not.toMatch(/componentId/);
    // Entfernt (undefined) = Feld fehlt in der Datei.
    const text = serializeProject(withTerrainComponent(sampleProjectComplex, undefined));
    expect(JSON.parse(text).context.find((o: { type: string }) => o.type === "terrainMesh").componentId).toBeUndefined();
  });
});
