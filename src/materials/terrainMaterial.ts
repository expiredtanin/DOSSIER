// Wiese für Gelände ohne eigenes Material ([211] Blender-Paket, [212] Pathtracer): ambientCG Grass005 aus der
// mitgelieferten Bibliothek (`public/assets/materials`), Kachel 4 m. Hat ein Gelände ein Bauteil mit Bildkarten
// (`TerrainMesh.componentId`), gilt dessen Material ({@link terrainComponentMaterial}).

import type { ComponentMaterial, Project, TerrainMesh } from "../model/types";

export const TERRAIN_GRASS_MATERIAL: ComponentMaterial = {
  libraryId: "Grass005",
  color: "/assets/materials/Grass005/color.jpg",
  normal: "/assets/materials/Grass005/normal.jpg",
  roughness: "/assets/materials/Grass005/roughness.jpg",
  sizeM: 4,
};

/** Gelände-Netze des Projekts. */
export function terrainMeshes(project: Project): TerrainMesh[] {
  return (project.context ?? []).filter((o): o is TerrainMesh => o.type === "terrainMesh");
}

/** Material (mit Farbkarte) des Bauteils eines Geländes, sonst undefined. */
export function terrainComponentMaterial(project: Project, terrain: TerrainMesh): ComponentMaterial | undefined {
  const id = terrain.componentId;
  if (!id) return undefined;
  const mat = (project.components ?? []).find((c) => c.id === id)?.material;
  return mat?.color ? mat : undefined;
}
