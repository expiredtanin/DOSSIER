/**
 * [212] Materialtabelle des Pathtracers: je Textur-Ebene ({@link wallMaterialColorMaps}) Baustoff-Name und Farbkarte,
 * in derselben Reihenfolge (render3d ordnet `materialIndex` i der Tabelle i − 1 zu).
 */

import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { pathtraceMaterials, wallMaterialColorMaps } from "./toWalls3d";

const sampleProjectComplex = buildComplexSampleProject();

describe("[212] pathtraceMaterials", () => {
  it("folgt den Textur-Ebenen und nennt den Baustoff", () => {
    const maps = wallMaterialColorMaps(sampleProjectComplex);
    const table = pathtraceMaterials(sampleProjectComplex);
    expect(maps.length).toBeGreaterThan(0);
    expect(table.map((e) => e.map)).toEqual(maps);
    for (const e of table) {
      const comp = (sampleProjectComplex.components ?? []).find((c) => c.name === e.name);
      expect(comp?.material?.color).toBe(e.map);
    }
  });

  it("gibt die Kachelgrösse der Bildkarte mit (Etappe 3)", () => {
    const table = pathtraceMaterials(sampleProjectComplex);
    for (const e of table) {
      const comp = (sampleProjectComplex.components ?? []).find((c) => c.material?.color === e.map);
      expect(e.size).toBe(comp?.material?.sizeM);
    }
    expect(table.some((e) => e.size !== undefined)).toBe(true);
  });

  it("leer ohne Farbkarten", () => {
    const bare = { ...sampleProjectComplex, components: (sampleProjectComplex.components ?? []).map((c) => ({ ...c, material: undefined })) };
    expect(pathtraceMaterials(bare)).toEqual([]);
  });
});
