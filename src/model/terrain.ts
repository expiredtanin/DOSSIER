// Gelände-Generierung (TIN) aus Konturen (Höhenlinien).
//
// Prinzip: Die Stütz-Vertices der Konturen werden als Punktmenge genommen
// (sie liegen direkt auf den Höhenlinien = bevorzugte „Breaklines"). Über deren
// (x,y)-Projektion wird eine 2D-Delaunay-Triangulation gelegt; die Z-Höhe je
// Vertex stammt aus der jeweiligen Kontur. Daraus entsteht ein TIN (Triangulated
// Irregular Network) als rohes positions/indices-Mesh (three-frei).
//
// Gelände ist NICHT semantisch — es ist Kontext-Geometrie (Project.context).

import { core } from "../engine/coreWasm";
import { toMarkedJson } from "../core/ops";
import type { Contour, TerrainMesh } from "./types";
import { TERRAIN_CATEGORY } from "./contextCategories";

let terrainSeq = 0;

/** Sichtbarer Ebenen-/Gruppierungsname des Geländes (SitePanel). */
export const TERRAIN_LAYER = "Terrain";

/**
 * Erzeugt ein TIN aus Konturen (Rust-Kern, `cmd_solid.rs::terrain_from_contours`): alle endlichen
 * Stützpunkte der Konturen als Vertices (Z = Kontur-Höhe, nicht endlich → 0), 2D-Delaunay über die
 * (x, y)-Projektion (`delaunay.rs`), Dreiecke mit (nahezu) null Fläche verworfen. Offene und
 * geschlossene Konturen gleich; unter 3 Punkten ein leeres Mesh.
 */
export function generateTerrainFromContours(contours: Contour[]): TerrainMesh {
  const id = `terrain-${Date.now()}-${terrainSeq++}`;
  return JSON.parse(core().terrain_from_contours_json(toMarkedJson(contours), id)) as TerrainMesh;
}

/**
 * Ein reguläres Höhenraster: sortierte X/Y-Achsen (lokale Meter) und eine
 * zeilenweise Höhenmatrix `z[row][col]` (Zeile = Y-Index, Spalte = X-Index).
 * Einzelne Zellen dürfen `null` sein (kein Messwert) — dort entstehen keine
 * Faces. Wird vom swisstopo-Terrain-Import (DTM-Profilraster) geliefert.
 */
export interface TerrainGrid {
  xs: number[];
  ys: number[];
  z: (number | null)[][];
  name?: string;
}

/**
 * Baut ein Terrain-Mesh aus einem regulären Höhenraster (Quad-Gitter → zwei
 * Dreiecke je Zelle). Fehlende Zellen (`null`) werden ausgelassen; eine Zelle
 * entsteht nur, wenn alle vier Ecken vorhanden sind. Rohes positions/indices-
 * Mesh (three-frei), analog {@link generateTerrainFromContours}.
 */
export function terrainMeshFromGrid(grid: TerrainGrid): TerrainMesh {
  const id = `terrain-${Date.now()}-${terrainSeq++}`;
  const name = grid.name ?? "Gelände";
  const { xs, ys, z } = grid;
  const nx = xs.length;
  const ny = ys.length;

  // Vertex-Index je (row, col) — nur für vorhandene Höhen. -1 = fehlt.
  const vidx: number[] = new Array(nx * ny).fill(-1);
  const positions: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const h = z[j]?.[i];
      if (h == null || !Number.isFinite(h)) continue;
      vidx[j * nx + i] = positions.length / 3;
      positions.push(xs[i], ys[j], h);
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = vidx[j * nx + i];
      const b = vidx[j * nx + (i + 1)];
      const c = vidx[(j + 1) * nx + (i + 1)];
      const d = vidx[(j + 1) * nx + i];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      // Quad a-b-c-d → zwei Dreiecke.
      indices.push(a, b, c, a, c, d);
    }
  }

  if (positions.length < 9 || indices.length < 3) {
    return { id, type: "terrainMesh", name, categoryCode: TERRAIN_CATEGORY.code, positions: [], indices: [] };
  }
  return {
    id,
    type: "terrainMesh",
    name,
    layer: TERRAIN_LAYER,
    categoryCode: TERRAIN_CATEGORY.code,
    positions,
    indices,
  };
}
