// Unit-Tests für den STL-/OBJ-Mesh-Export (reines Modul, siehe exportMesh.ts).
//   • OBJ: ≥1 v/f, alle f-Indizes innerhalb der Vertexzahl, alle Koordinaten endlich.
//   • STL: solid/endsolid-Rahmen, Facettenzahl = Dreieckszahl, je Facette genau 3 vertex-Zeilen.
//   • Dreieckszahl-Plausibilität: isolierte Wand-Box (12) und isoliertes N-Eck-Prisma (4N-4).
//   • leeres Projekt ⇒ gültige leere Datei (kein Crash).

import { describe, it, expect } from "vitest";
import "../engine/fileioWasm.setup";
import { exportObj, exportStl } from "./exportMesh";
import type { Project, Wall, Ceiling, ExtrudedSolid, Opening } from "../model/types";

/** Nur die Wand (ohne Rahmen/Glas der Öffnung): die Tests zählen die Dreiecke des ausgeschnittenen Wandkörpers. */
const WALL_ONLY = { openingParts: false };

/** Gemeinsame Ressourcen-Basis (Komponente/Wandtyp/Deckentyp/Geschoss/Ebene). */
function baseProject(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "Aussenwand", layers: [{ componentId: "c", thickness: 0.4 }] }],
    ceilingTypes: [{ id: "dt", name: "Betondecke", layers: [{ componentId: "c", thickness: 0.2 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    extrudedSolids: [],
    rooms: [],
    drawings2d: [],
    context: [],
  } as Project;
}

/** Eine einzelne, frei stehende Wand (kein Nachbar ⇒ kein Gehrungs-/Anschlussschnitt). */
function projectWithOneWall(): Project {
  const p = baseProject();
  const wall: Wall = {
    id: "W1",
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start: { x: 0, y: 0 },
    end: { x: 5, y: 0 },
    wallTypeId: "aw",
    height: 2.6,
  };
  p.walls = [wall];
  return p;
}

/**
 * Eine frei stehende Wand mit EINER Öffnung (Fenster ODER Tür). Das Fenster
 * (sillHeight>0) liegt vollständig im Wand-Inneren (vier Laibungen); die Tür
 * (sillHeight 0) berührt die Wand-UK (keine untere Laibung).
 */
function projectWithOpening(kind: "window" | "door"): Project {
  const p = projectWithOneWall();
  const opening: Opening = {
    id: kind === "window" ? "F1" : "T1",
    type: "opening",
    hostWallId: "W1",
    categoryCode: "21",
    kind,
    position: 2,
    width: 1,
    height: kind === "window" ? 1.5 : 2.1,
    sillHeight: kind === "window" ? 0.9 : 0,
  };
  p.openings = [opening];
  return p;
}

/** Eine einzelne Extrusion mit N-Eck-Profil (kein Wand-/Deckenkontext). */
function projectWithPolygonExtrusion(pts: { x: number; y: number }[], height = 2.5): Project {
  const p = baseProject();
  const solid: ExtrudedSolid = {
    id: "E1",
    type: "extrudedSolid",
    levelId: "eg",
    points: pts,
    height,
  };
  p.extrudedSolids = [solid];
  return p;
}

/** Kombiniertes Fixture-Projekt: 2 Wände (Eckstoss), 1 Decke, 1 Extrusion. */
function fixtureProject(): Project {
  const p = baseProject();
  const walls: Wall[] = [
    {
      id: "W1",
      type: "wall",
      floorId: "eg",
      categoryCode: "20",
      start: { x: 0, y: 0 },
      end: { x: 5, y: 0 },
      wallTypeId: "aw",
      height: 2.6,
    },
    {
      id: "W2",
      type: "wall",
      floorId: "eg",
      categoryCode: "20",
      start: { x: 5, y: 0 },
      end: { x: 5, y: 4 },
      wallTypeId: "aw",
      height: 2.6,
    },
  ];
  const ceilings: Ceiling[] = [
    {
      id: "D1",
      type: "ceiling",
      floorId: "eg",
      categoryCode: "30",
      outline: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 4 },
        { x: 0, y: 4 },
      ],
      wallTypeId: "dt",
      ceilingTypeId: "dt",
    },
  ];
  const extrudedSolids: ExtrudedSolid[] = [
    {
      id: "E1",
      type: "extrudedSolid",
      levelId: "eg",
      points: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 3 },
        { x: 0, y: 3 },
      ],
      height: 2.5,
    },
  ];
  p.walls = walls;
  p.ceilings = ceilings;
  p.extrudedSolids = extrudedSolids;
  return p;
}

/** Parst die `v`-Zeilen eines OBJ-Strings zu Koordinaten-Tripeln. */
function parseObjVertices(obj: string): number[][] {
  return obj
    .split("\n")
    .filter((l) => l.startsWith("v "))
    .map((l) => l.slice(2).trim().split(/\s+/).map(Number));
}

/** Parst die `f`-Zeilen eines OBJ-Strings zu 1-basierten Index-Tripeln. */
function parseObjFaces(obj: string): number[][] {
  return obj
    .split("\n")
    .filter((l) => l.startsWith("f "))
    .map((l) => l.slice(2).trim().split(/\s+/).map(Number));
}

describe("exportObj — Wavefront-OBJ-Export", () => {
  it("liefert ≥1 v und ≥1 f, alle f-Indizes innerhalb der Vertexzahl, alle Koordinaten endlich", () => {
    const obj = exportObj(fixtureProject());
    const verts = parseObjVertices(obj);
    const faces = parseObjFaces(obj);
    expect(verts.length).toBeGreaterThan(0);
    expect(faces.length).toBeGreaterThan(0);
    for (const v of verts) {
      expect(v).toHaveLength(3);
      for (const c of v) expect(Number.isFinite(c)).toBe(true);
    }
    for (const f of faces) {
      expect(f).toHaveLength(3);
      for (const idx of f) {
        expect(idx).toBeGreaterThanOrEqual(1);
        expect(idx).toBeLessThanOrEqual(verts.length);
      }
    }
  });

  it("gruppiert Bauteil-Vorkommen als o-Objekte (Wand/Decke/Extrusion)", () => {
    const obj = exportObj(fixtureProject());
    expect(obj).toContain("o Wand_W1");
    expect(obj).toContain("o Wand_W2");
    expect(obj).toContain("o Decke_D1");
    expect(obj).toContain("o Extrusion_E1");
  });

  it("leeres Projekt ⇒ gültige Datei ohne v/f (kein Crash)", () => {
    const obj = exportObj(baseProject());
    expect(obj.split("\n").some((l) => l.startsWith("v "))).toBe(false);
    expect(obj.split("\n").some((l) => l.startsWith("f "))).toBe(false);
    expect(obj.length).toBeGreaterThan(0);
  });
});

describe("exportStl — ASCII-STL-Export", () => {
  it("hat solid/endsolid-Rahmen, je Facette genau 3 vertex-Zeilen, Facettenzahl = Dreieckszahl", () => {
    const stl = exportStl(fixtureProject());
    const lines = stl.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("solid dossier");
    expect(lines[lines.length - 1]).toBe("endsolid dossier");
    const facetCount = lines.filter((l) => l.startsWith("facet normal")).length;
    const loopCount = lines.filter((l) => l === "outer loop").length;
    const endloopCount = lines.filter((l) => l === "endloop").length;
    const endfacetCount = lines.filter((l) => l === "endfacet").length;
    const vertexCount = lines.filter((l) => l.startsWith("vertex ")).length;
    expect(facetCount).toBeGreaterThan(0);
    expect(loopCount).toBe(facetCount);
    expect(endloopCount).toBe(facetCount);
    expect(endfacetCount).toBe(facetCount);
    expect(vertexCount).toBe(facetCount * 3);
  });

  it("leeres Projekt ⇒ gültiges leeres solid-Gerüst (kein Crash)", () => {
    const stl = exportStl(baseProject());
    expect(stl).toBe("solid dossier\nendsolid dossier\n");
  });

  it("Dreieckszahl-Plausibilität: eine frei stehende Wand ergibt genau 1 Box (12 Dreiecke, 8 Ecken)", () => {
    const stl = exportStl(projectWithOneWall());
    const facetCount = stl.split("\n").filter((l) => l.startsWith("facet normal")).length;
    expect(facetCount).toBe(12);
    const obj = exportObj(projectWithOneWall());
    expect(parseObjVertices(obj)).toHaveLength(8);
  });

  it("Dreieckszahl-Plausibilität: ein N-Eck-Profil ergibt ein Prisma mit 4N-4 Dreiecken (2N Ecken)", () => {
    // Rechteck (N=4): 2 Kappen à 2 Dreiecke + 4 Seitenquads à 2 Dreiecke = 12 = 4·4−4.
    const rectStl = exportStl(
      projectWithPolygonExtrusion([
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 0, y: 1 },
      ]),
    );
    expect(rectStl.split("\n").filter((l) => l.startsWith("facet normal")).length).toBe(12);

    // Konvexes Fünfeck (N=5): 4·5−4 = 16 Dreiecke, 10 Ecken.
    const pentagon = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2.5, y: 1.5 },
      { x: 1, y: 2.5 },
      { x: -0.5, y: 1.5 },
    ];
    const pentaStl = exportStl(projectWithPolygonExtrusion(pentagon));
    expect(pentaStl.split("\n").filter((l) => l.startsWith("facet normal")).length).toBe(16);
    const pentaObj = exportObj(projectWithPolygonExtrusion(pentagon));
    expect(parseObjVertices(pentaObj)).toHaveLength(10);
  });

  it("Fenster wird als echtes Loch ausgeschnitten (Gitter-Zerlegung + 4 Laibungen, 48 Dreiecke statt 12)", () => {
    // Fenster [x 2..3] × [y 0.9..2.4] vollständig im Wand-Inneren. Erwartung
    // (= Rust-Zerlegung `extrude_layer_segment_with_holes`): 8 solide Langseiten-
    // Teilrechtecke (3×3-Gitter minus Loch) × 2 Seiten × 2 Dreiecke = 32,
    // + Deckel/Boden/2 Stirnkappen = 8, + 4 Laibungen × 2 = 8 → 48 Dreiecke.
    const stl = exportStl(projectWithOpening("window"), WALL_ONLY);
    const facetCount = stl.split("\n").filter((l) => l.startsWith("facet normal")).length;
    expect(facetCount).toBe(48);

    // Die volle Box hätte NUR Ecken bei y∈{0,2.6}, x∈{0,5}. Der Ausschnitt
    // führt echte Vertices an den Loch-Rändern ein — Beweis, dass das Loch
    // wirklich in der Fläche steckt (nicht bloss eine übergelegte Scheibe).
    const verts = parseObjVertices(exportObj(projectWithOpening("window"), WALL_ONLY));
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    expect(verts.some((v) => near(v[1], 0.9))).toBe(true); // Brüstungs-OK
    expect(verts.some((v) => near(v[1], 2.4))).toBe(true); // Sturz-UK
    expect(verts.some((v) => near(v[0], 2))).toBe(true); // linke Loch-Kante
    expect(verts.some((v) => near(v[0], 3))).toBe(true); // rechte Loch-Kante
    // Deutlich mehr Vertices als die 8-Ecken-Vollbox.
    expect(verts.length).toBe(144);
  });

  it("Tür berührt die Wand-UK: keine untere Laibung (36 Dreiecke, keine Brüstungs-Zerlegung)", () => {
    // Tür [x 2..3] × [y 0..2.1]: Boden bekommt die Lücke [2,3] (statt einer
    // unteren Laibung) → 5 Langseiten-Teilrechtecke × 2 × 2 = 20, Deckel(1)=2,
    // Boden(2 Streifen)=4, 2 Stirnkappen=4, 3 Laibungen (links/rechts/oben)=6 → 36.
    const stl = exportStl(projectWithOpening("door"), WALL_ONLY);
    const facetCount = stl.split("\n").filter((l) => l.startsWith("facet normal")).length;
    expect(facetCount).toBe(36);
    const verts = parseObjVertices(exportObj(projectWithOpening("door"), WALL_ONLY));
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    // Sturz-UK bei y=2.1 vorhanden, aber KEIN Brüstungsvertex (Tür sitzt am Boden).
    expect(verts.some((v) => near(v[1], 2.1))).toBe(true);
    expect(verts.every((v) => v[1] >= -1e-6 && v[1] <= 2.6 + 1e-6)).toBe(true);
  });

  it("facet-Normalen sind Einheitsvektoren aus dem Kreuzprodukt der Dreiecksecken", () => {
    const stl = exportStl(projectWithOneWall());
    const facetLines = stl.split("\n").filter((l) => l.startsWith("facet normal"));
    for (const line of facetLines) {
      const [nx, ny, nz] = line.slice("facet normal ".length).trim().split(/\s+/).map(Number);
      const len = Math.hypot(nx, ny, nz);
      expect(len).toBeGreaterThan(0.99);
      expect(len).toBeLessThan(1.01);
    }
  });
});
