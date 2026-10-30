// Tests für den Terrain-Mesh-Aufbau aus einem regulären Höhenraster
// (swisstopo-DTM-Profilraster → terrainMeshFromGrid).

import { describe, it, expect } from "vitest";
import { smoothTerrainGrid, terrainMeshFromGrid } from "./terrain";
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

describe("[T6] Höhenraster glätten", () => {
  it("baut Spitzen ab, lässt Lücken und Ebenen", () => {
    const xs = [0, 1, 2, 3, 4];
    const flat = Array.from({ length: 5 }, () => Array<number | null>(5).fill(2));
    expect(smoothTerrainGrid({ xs, ys: xs, z: flat }, 3).z.flat().every((v) => Math.abs((v as number) - 2) < 1e-12)).toBe(true);
    const z = Array.from({ length: 5 }, () => Array<number | null>(5).fill(0));
    z[2][2] = 8;
    z[0][0] = null;
    const g = smoothTerrainGrid({ xs, ys: xs, z }, 1);
    expect((g.z[2][2] as number) < 8 && (g.z[2][2] as number) > 1).toBe(true);
    expect(g.z[0][0]).toBeNull();
    expect(smoothTerrainGrid({ xs, ys: xs, z }, 0)).toEqual({ xs, ys: xs, z });
  });
});
