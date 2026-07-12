// Tests für die reinen (netzwerkfreien) Bausteine des swissBUILDINGS3D-STAC-
// Imports: Koordinaten-Verschiebung der geparsten Meshes. Asset-Auswahl wird
// generisch in `stacApi.test.ts` getestet. Der eigentliche Netzwerk-Fetch
// (`fetchBuildings3d`) bleibt ungetestet, analog zu
// `swissTopo.ts::fetchBuildings`/`geocode` (kein Fetch-Mocking im Repo).

import { describe, it, expect } from "vitest";
import { shiftMeshToOrigin, clipMeshToBbox } from "./swissBuildings3d";
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

describe("clipMeshToBbox", () => {
  // Zwei Dreiecke: #0 ganz innerhalb der Box, #1 ganz ausserhalb (weit weg,
  // simuliert ein Nachbargebäude aus derselben STAC-Kachel ausserhalb des
  // gesuchten Radius).
  const mesh: ImportedMesh = {
    id: "m1",
    type: "importedMesh",
    name: "roh",
    positions: [
      0, 0, 0, 1, 0, 0, 0, 1, 0, // Dreieck 0: innerhalb [-5,5]
      1000, 1000, 0, 1001, 1000, 0, 1000, 1001, 0, // Dreieck 1: weit ausserhalb
    ],
    indices: [0, 1, 2, 3, 4, 5],
  };

  it("behält nur Dreiecke mit mindestens einem Eckpunkt in der Box", () => {
    const clipped = clipMeshToBbox(mesh, [-5, -5, 5, 5]);
    expect(clipped.indices).toEqual([0, 1, 2]);
  });

  it("leere Box -> leere Indizes (kein Absturz)", () => {
    const clipped = clipMeshToBbox(mesh, [500, 500, 500, 500]);
    expect(clipped.indices).toEqual([]);
  });

  it("Box umfasst alles -> alle Dreiecke bleiben", () => {
    const clipped = clipMeshToBbox(mesh, [-2000, -2000, 2000, 2000]);
    expect(clipped.indices).toEqual(mesh.indices);
  });

  it("ein Dreieck, das die Box-Kante überragt, bleibt VOLLSTÄNDIG erhalten (kein Mittendurch-Schnitt)", () => {
    const straddling: ImportedMesh = {
      id: "m2",
      type: "importedMesh",
      name: "roh",
      positions: [4, 0, 0, 10, 0, 0, 4, 10, 0], // ein Eckpunkt (4,0) in [-5,5], zwei ausserhalb
      indices: [0, 1, 2],
    };
    const clipped = clipMeshToBbox(straddling, [-5, -5, 5, 5]);
    expect(clipped.indices).toEqual([0, 1, 2]);
  });
});
