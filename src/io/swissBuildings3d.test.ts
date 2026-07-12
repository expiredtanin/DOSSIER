// Tests für die reinen (netzwerkfreien) Bausteine des swissBUILDINGS3D-STAC-
// Imports: Koordinaten-Verschiebung der geparsten Meshes. Asset-Auswahl wird
// generisch in `stacApi.test.ts` getestet. Der eigentliche Netzwerk-Fetch
// (`fetchBuildings3d`) bleibt ungetestet, analog zu
// `swissTopo.ts::fetchBuildings`/`geocode` (kein Fetch-Mocking im Repo).

import { describe, it, expect } from "vitest";
import { shiftMeshToOrigin } from "./swissBuildings3d";
import type { ImportedMesh } from "../model/types";

describe("shiftMeshToOrigin", () => {
  it("verschiebt x/y um die Origin, lässt z unverändert", () => {
    const mesh: ImportedMesh = {
      id: "m1",
      type: "importedMesh",
      name: "roh",
      positions: [2600100, 1200050, 3.5, 2600110, 1200060, 7.2],
      indices: [0, 1, 0],
    };
    const shifted = shiftMeshToOrigin(mesh, { e: 2600000, n: 1200000 }, "tile-42");
    expect(shifted.positions).toEqual([100, 50, 3.5, 110, 60, 7.2]);
    expect(shifted.indices).toBe(mesh.indices);
    expect(shifted.name).toContain("tile-42");
  });

  it("mutiert das Eingabe-Mesh nicht", () => {
    const mesh: ImportedMesh = {
      id: "m1",
      type: "importedMesh",
      name: "roh",
      positions: [2600100, 1200050, 0],
      indices: [],
    };
    const original = mesh.positions.slice();
    shiftMeshToOrigin(mesh, { e: 2600000, n: 1200000 }, "x");
    expect(mesh.positions).toEqual(original);
  });
});
