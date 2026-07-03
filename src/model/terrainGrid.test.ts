// Tests für den Terrain-Mesh-Aufbau aus einem regulären Höhenraster
// (swisstopo-DTM-Profilraster → terrainMeshFromGrid).

import { describe, it, expect } from "vitest";
import { terrainMeshFromGrid } from "./terrain";
import type { TerrainGrid } from "./terrain";

describe("terrainMeshFromGrid", () => {
  it("baut ein vollständiges Quad-Gitter (3×3 → 8 Dreiecke)", () => {
    const grid: TerrainGrid = {
      xs: [0, 10, 20],
      ys: [0, 10, 20],
      z: [
        [1, 2, 3],
        [2, 3, 4],
        [3, 4, 5],
      ],
    };
    const mesh = terrainMeshFromGrid(grid);
    expect(mesh.type).toBe("terrainMesh");
    // 9 Vertices × 3 Komponenten.
    expect(mesh.positions.length).toBe(9 * 3);
    // 2×2 Zellen × 2 Dreiecke × 3 Indizes.
    expect(mesh.indices.length).toBe(2 * 2 * 2 * 3);
  });

  it("lässt Zellen mit fehlender (null) Ecke aus", () => {
    const grid: TerrainGrid = {
      xs: [0, 10, 20],
      ys: [0, 10, 20],
      z: [
        [1, 2, 3],
        [2, null, 4],
        [3, 4, 5],
      ],
    };
    const mesh = terrainMeshFromGrid(grid);
    // Die fehlende Mitte gehört zu allen 4 Zellen → keine Faces übrig.
    expect(mesh.indices.length).toBe(0);
  });

  it("überträgt die Höhen als Z-Koordinate (Modell x,y,z)", () => {
    const grid: TerrainGrid = {
      xs: [0, 10],
      ys: [0, 10],
      z: [
        [5, 7],
        [9, 11],
      ],
    };
    const mesh = terrainMeshFromGrid(grid);
    const zs: number[] = [];
    for (let i = 2; i < mesh.positions.length; i += 3) zs.push(mesh.positions[i]);
    expect(zs.sort((a, b) => a - b)).toEqual([5, 7, 9, 11]);
  });
});
