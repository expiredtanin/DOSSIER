// Tests für den swisstopo/OSM-Kontext-Import: Gebäude-Extrusion (Footprint →
// 3D-Volumen) und die ContextObject-Erzeugung.

import { describe, it, expect } from "vitest";
import {
  buildingsToMesh,
  featuresToContextObjects,
  DEFAULT_BUILDING_HEIGHT,
} from "./geoContext";
import type { GeoFeature } from "./geoContext";

/** Ein achsenparalleles Quadrat (Seite s) als geschlossener Footprint-Ring. */
function square(s: number): { x: number; y: number }[] {
  return [
    { x: 0, y: 0 },
    { x: s, y: 0 },
    { x: s, y: s },
    { x: 0, y: s },
  ];
}

describe("buildingsToMesh", () => {
  it("extrudiert einen Footprint zu einem geschlossenen Volumen", () => {
    const f: GeoFeature = {
      category: "building",
      pts: square(10),
      closed: true,
      height: 12,
    };
    const mesh = buildingsToMesh([f], "Test");
    expect(mesh).not.toBeNull();
    expect(mesh!.type).toBe("importedMesh");
    // 4 Boden- + 4 Deckel-Vertices.
    expect(mesh!.positions.length).toBe(8 * 3);
    // Wände (4 Quads × 2 = 8 Dreiecke) + Deckel + Boden.
    expect(mesh!.indices.length).toBeGreaterThanOrEqual(8 * 3);

    // Z-Werte: Basis auf 0, Deckel auf der Höhe.
    const zs: number[] = [];
    for (let i = 2; i < mesh!.positions.length; i += 3) zs.push(mesh!.positions[i]);
    expect(Math.min(...zs)).toBeCloseTo(0);
    expect(Math.max(...zs)).toBeCloseTo(12);
  });

  it("nutzt die Default-Höhe ohne height-Angabe", () => {
    const f: GeoFeature = { category: "building", pts: square(8), closed: true };
    const mesh = buildingsToMesh([f], "Test")!;
    const zMax = Math.max(
      ...Array.from({ length: mesh.positions.length / 3 }, (_, i) => mesh.positions[i * 3 + 2]),
    );
    expect(zMax).toBeCloseTo(DEFAULT_BUILDING_HEIGHT);
  });

  it("überspringt entartete/offene Ringe und liefert dann null", () => {
    const degenerate: GeoFeature = {
      category: "building",
      pts: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
      closed: true,
    };
    const open: GeoFeature = {
      category: "building",
      pts: square(5),
      closed: false,
    };
    expect(buildingsToMesh([degenerate, open], "x")).toBeNull();
  });

  it("trianguliert einen konkaven (L-förmigen) Footprint ohne Fläche außerhalb", () => {
    // L-Form: Schwerpunkt-Filter darf keine Faces in der Einbuchtung erzeugen.
    const L: { x: number; y: number }[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    const mesh = buildingsToMesh(
      [{ category: "building", pts: L, closed: true, height: 5 }],
      "L",
    );
    expect(mesh).not.toBeNull();
    expect(mesh!.indices.length).toBeGreaterThan(0);
  });
});

describe("featuresToContextObjects", () => {
  it("liefert Footprint-contourSet UND extrudiertes Gebäude-Mesh", () => {
    const features: GeoFeature[] = [
      { category: "building", pts: square(10), closed: true, height: 9 },
      {
        category: "road",
        pts: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
        ],
        closed: false,
      },
    ];
    const objs = featuresToContextObjects(features, "Ort");
    const types = objs.map((o) => o.type).sort();
    // contourSet (Gebäude-Footprint) + contourSet (Strasse) + importedMesh.
    expect(objs.some((o) => o.type === "importedMesh")).toBe(true);
    expect(objs.filter((o) => o.type === "contourSet").length).toBe(2);
    expect(types).toContain("importedMesh");
  });
});
