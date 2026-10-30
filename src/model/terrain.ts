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
 * Erzeugt ein Gelände aus Konturen (Rust-Kern, `terrain.rs`): Konturen verdichtet und als Bruchkanten
 * erzwungen (constrained Delaunay), flache Dreiecke behoben, adaptiv geglättet ohne Überschwingen.
 * `contourInterval` = kleinster Höhenabstand der Konturen (Höhenlinien im Grundriss). Unter 3 Punkten
 * ein leeres Mesh.
 */
export function generateTerrainFromContours(contours: Contour[], opts: TerrainOptions = {}): TerrainMesh {
  const id = `terrain-${Date.now()}-${terrainSeq++}`;
  const json = core().terrain_from_contours_opts_json(
    toMarkedJson(contours),
    id,
    opts.smooth ?? 2,
    opts.maxEdge ?? 0,
    opts.breaklines === false ? 0 : 1,
  );
  return JSON.parse(json) as TerrainMesh;
}

/**
 * [T6] Optionen der Gelände-Erzeugung (`terrain.rs`): `smooth` = Glättungsstufen 0–4 (0 = reines TIN mit
 * Bruchkanten, Standard 2), `maxEdge` = Verdichtung/grösste Kante in m (0 = automatisch), `breaklines` =
 * Höhenlinien als Bruchkanten erzwingen (Standard ja).
 */
export interface TerrainOptions {
  smooth?: number;
  maxEdge?: number;
  breaklines?: boolean;
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
    contourInterval: 1,
  };
}
