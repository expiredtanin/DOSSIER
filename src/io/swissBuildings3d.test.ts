// Tests für die reinen (netzwerkfreien) Bausteine des swissBUILDINGS3D-STAC-
// Imports: Koordinaten-Verschiebung der geparsten Meshes. Asset-Auswahl wird
// generisch in `stacApi.test.ts` getestet. Der eigentliche Netzwerk-Fetch
// (`fetchBuildings3d`) bleibt ungetestet, analog zu
// `swissTopo.ts::fetchBuildings`/`geocode` (kein Fetch-Mocking im Repo).

import { describe, it, expect } from "vitest";
import {
  shiftMeshToOrigin,
  clipMeshToBbox,
  splitMeshComponents,
  stripOverhangSoffits,
  concatMeshes,
  BUILDING_LAYER,
} from "./swissBuildings3d";
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

describe("splitMeshComponents", () => {
  // Zwei räumlich getrennte Dreiecke (kein gemeinsamer Vertex) = zwei Gebäude.
  const twoBuildings: ImportedMesh = {
    id: "m1",
    type: "importedMesh",
    name: "Kachel",
    positions: [
      0, 0, 0, 1, 0, 0, 0, 1, 0, // Gebäude A
      100, 100, 0, 101, 100, 0, 100, 101, 0, // Gebäude B (weit weg)
    ],
    indices: [0, 1, 2, 3, 4, 5],
  };

  it("trennt zwei unverbundene Dreiecke in zwei Meshes mit eigener Id + Ebene", () => {
    const parts = splitMeshComponents(twoBuildings);
    expect(parts.length).toBe(2);
    expect(parts[0].id).not.toBe(parts[1].id);
    for (const p of parts) {
      expect(p.layer).toBe(BUILDING_LAYER);
      expect(p.indices.length).toBe(3); // je ein Dreieck
      expect(p.positions.length).toBe(9); // kompaktiert: nur die 3 eigenen Vertices
      // Indizes sind neu gemappt (0..2), zeigen nicht mehr auf die alten Globalindizes.
      expect(Math.max(...p.indices)).toBeLessThan(3);
    }
  });

  it("verschweisst geteilte Eckpunkte: zwei Dreiecke mit gemeinsamer Kante bleiben EIN Gebäude", () => {
    // Zwei Dreiecke teilen die Kante (1,0)-(0,1), aber über DUPLIZIERTE Vertices
    // (getrennte Indizes, gleiche Koordinaten) — das Welding muss sie verbinden.
    const shared: ImportedMesh = {
      id: "m2",
      type: "importedMesh",
      name: "Haus",
      positions: [
        0, 0, 0, 1, 0, 0, 0, 1, 0, // Dreieck 1: (0,0),(1,0),(0,1)
        1, 0, 0, 0, 1, 0, 1, 1, 0, // Dreieck 2: (1,0),(0,1),(1,1) — dupl. Ecken
      ],
      indices: [0, 1, 2, 3, 4, 5],
    };
    const parts = splitMeshComponents(shared);
    expect(parts.length).toBe(1);
    expect(parts[0].indices.length).toBe(6);
  });

  it("ein einzelnes zusammenhängendes Mesh bleibt ein Mesh (bekommt aber die Ebene)", () => {
    const one: ImportedMesh = {
      id: "m3",
      type: "importedMesh",
      name: "Solo",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    };
    const parts = splitMeshComponents(one);
    expect(parts.length).toBe(1);
    expect(parts[0].layer).toBe(BUILDING_LAYER);
  });

  it("leeres/entartetes Mesh -> leeres Ergebnis (kein Crash)", () => {
    const empty: ImportedMesh = { id: "e", type: "importedMesh", name: "x", positions: [], indices: [] };
    expect(splitMeshComponents(empty)).toEqual([]);
  });
});

describe("stripOverhangSoffits", () => {
  // Sockel (z=0) + Soffit/Wandkopf-Ring (z=2.5, EINE Dreieck-Fläche zeigt nach
  // unten = Überstand-Untersicht) + Dach (z=3, nach oben) + zwei Wanddreiecke
  // (senkrecht, nz≈0). Simuliert einen minimalen swissBUILDINGS3D-Baukörper mit
  // einer sichtbaren Dachüberstand-Untersicht (Nutzer-Report: "man sieht die
  // Wände von unten").
  it("entfernt eine nach unten zeigende Überstand-Untersicht oberhalb der Grundmauer", () => {
    const mesh: ImportedMesh = {
      id: "m1",
      type: "importedMesh",
      name: "Haus",
      positions: [
        0, 0, 0, // 0: Sockel
        1, 0, 0, // 1: Sockel
        0, 1, 0, // 2: Sockel
        0, 0, 2.5, // 3: Wandkopf
        1, 0, 2.5, // 4: Wandkopf
        0, 1, 2.5, // 5: Wandkopf (nur vom Soffit referenziert)
        0, 0, 3, // 6: Dach
        1, 0, 3, // 7: Dach
        0, 1, 3, // 8: Dach
      ],
      indices: [
        0, 1, 2, // Sockel-Deckel (bleibt immer)
        3, 5, 4, // Soffit (Normale zeigt nach unten, nz=-1) -> entfernt
        6, 7, 8, // Dach (Normale zeigt nach oben, nz=+1) -> bleibt
        0, 1, 4, // Wand (senkrecht, nz≈0) -> bleibt
        0, 4, 3, // Wand (senkrecht, nz≈0) -> bleibt
      ],
    };
    const out = stripOverhangSoffits(mesh);
    // 5 Dreiecke -> 4 (Soffit weg) = 12 Indizes.
    expect(out.indices.length).toBe(12);
    // Vertex 5 wird nur vom Soffit referenziert -> nach Kompaktierung weg
    // (8 statt 9 Vertices).
    expect(out.positions.length).toBe(24);
  });

  it("lässt ein Mesh ohne Soffiten unverändert", () => {
    const mesh: ImportedMesh = {
      id: "m1",
      type: "importedMesh",
      name: "Dreieck",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    };
    const out = stripOverhangSoffits(mesh);
    expect(out.indices).toEqual([0, 1, 2]);
    expect(out.positions).toEqual(mesh.positions);
  });

  it("behält den Boden-/Sockel-Deckel unabhängig von seiner Windung", () => {
    // Ein Dreieck exakt auf der Grundmauer-Höhe mit nach-unten-Windung -> die
    // Boden-Ausnahme greift VOR der Normalen-Prüfung, bleibt also erhalten.
    const mesh: ImportedMesh = {
      id: "m1",
      type: "importedMesh",
      name: "Sockel",
      positions: [0, 0, 0, 0, 1, 0, 1, 0, 0], // a,c,b-Reihenfolge -> nz=-1
      indices: [0, 1, 2],
    };
    const out = stripOverhangSoffits(mesh);
    expect(out.indices.length).toBe(3);
  });

  it("leeres/entartetes Mesh -> unverändert (kein Crash)", () => {
    const empty: ImportedMesh = { id: "e", type: "importedMesh", name: "x", positions: [], indices: [] };
    expect(stripOverhangSoffits(empty)).toBe(empty);
  });
});

describe("concatMeshes", () => {
  const tri = (id: string, ox: number): ImportedMesh => ({
    id,
    type: "importedMesh",
    name: id,
    layer: id,
    positions: [ox, 0, 0, ox + 1, 0, 0, ox, 1, 0],
    indices: [0, 1, 2],
  });

  it("führt Positions/Indizes mehrerer Meshes versetzt zusammen", () => {
    const merged = concatMeshes([tri("a", 0), tri("b", 10)]);
    expect(merged?.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0]);
    // zweites Dreieck referenziert um 3 (erste Mesh-Vertexzahl) versetzte Indizes.
    expect(merged?.indices).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("leere Teile (kein Dreieck) werden übersprungen, kein Beitrag zu Positions/Indizes", () => {
    const emptyPart: ImportedMesh = { id: "e", type: "importedMesh", name: "e", positions: [1, 2, 3], indices: [] };
    const merged = concatMeshes([emptyPart, tri("a", 0)]);
    expect(merged?.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("genau EIN nicht-leerer Teil -> dieselbe Referenz (kein unnötiges Kopieren)", () => {
    const only = tri("a", 0);
    expect(concatMeshes([only])).toBe(only);
  });

  it("ausschliesslich leere Teile -> null", () => {
    const empty: ImportedMesh = { id: "e", type: "importedMesh", name: "e", positions: [], indices: [] };
    expect(concatMeshes([empty, empty])).toBeNull();
  });

  it("übernimmt Metadaten (z. B. `layer`) vom ERSTEN nicht-leeren Teil", () => {
    const merged = concatMeshes([tri("a", 0), tri("b", 10)]);
    expect(merged?.layer).toBe("a");
  });
});
