import { describe, expect, it } from "vitest";
import type { Project } from "../../model/types";
import { sampleProject } from "../../model/sampleProject";
import { emitDrawingLines } from "./drawing2d";

// Regression fürs Nord-Achsen-Vorzeichen der 2D-Boden-Spuren im 3D (Nutzer-
// Report 2026-09-25: "eine in 3D gezeichnete Linie erscheint danach
// gespiegelt — nur bei 2D-Elementen"; 2026-09-27 auf weitere Bauteile
// ausgeweitet). `emitDrawingLines` geht über `RMesh.kind:"extrusion"` an
// render3d — `append_context_mesh` (Rust) negiert die Nord-Achse NUR für
// `"imported"`/`"terrain"` (echte, unabhängige Import-Rohdaten), NICHT für
// `"extrusion"` (orientierungserhaltende, plan-abgeleitete Geometrie wie
// Wand/Dach/Treppe/Öffnung). Die JS-Seite gibt die Positionen daher
// UNVERÄNDERT (kein manuelles Vorzeichen-Spiel mehr nötig) — dieselbe
// Konvention wie das drei.js-Pendant `addDrawing2DLines`.
describe("emitDrawingLines — Nord-Achsen-Vorzeichen (kind:\"extrusion\" statt \"imported\")", () => {
  it("lässt Modell-x/-y unverändert (keine Negation), kind ist \"extrusion\"", () => {
    const withLine: Project = {
      ...sampleProject,
      drawings2d: [
        {
          id: "D1",
          type: "drawing2d",
          levelId: "eg",
          categoryCode: "2d-line",
          // Reine "Nord"-Linie (kein x-Versatz) — am einfachsten zu prüfen:
          // model (0,0) -> (0,5), Ribbon-Breite vernachlässigbar (0.008m).
          geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 0, y: 5 } },
        },
      ],
    };
    const meshes = emitDrawingLines(withLine);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].kind).toBe("extrusion");
    const pos = meshes[0].positions;
    // 4 Vertices (Ribbon-Quad) x 3 Floats, Reihenfolge a+nx, a-nx, b-nx, b+nx
    // (s. `emitDrawingLines`) — Vertex 0/1 liegen also bei a (Modell-y=0),
    // Vertex 2/3 bei b (Modell-y=5). Der Quer-Versatz (nx, senkrecht zur
    // Nord-Süd-Richtung) ist die halbe Ribbon-Breite (0.008m) auf der
    // x-Achse; der Längs-Versatz (ny) ist bei dieser Linienrichtung null.
    const yOf = (vertexIdx: number) => pos[vertexIdx * 3 + 1];
    const xOf = (vertexIdx: number) => pos[vertexIdx * 3];
    expect(yOf(0)).toBeCloseTo(0, 6);
    expect(yOf(1)).toBeCloseTo(0, 6);
    // b-Ende (Modell-y=5): bleibt +5 (KEINE Negation mehr).
    expect(yOf(2)).toBeCloseTo(5, 6);
    expect(yOf(3)).toBeCloseTo(5, 6);
    // x um die halbe Ribbon-Breite versetzt (±0.008m).
    for (const i of [0, 1, 2, 3]) expect(Math.abs(xOf(i))).toBeCloseTo(0.008, 6);
  });

  it("Höhe (dritte Komponente) bleibt unverändert positiv (Geschoss-UK + Epsilon)", () => {
    const withLine: Project = {
      ...sampleProject,
      drawings2d: [
        {
          id: "D1",
          type: "drawing2d",
          levelId: "eg",
          categoryCode: "2d-line",
          geom: { shape: "line", a: { x: 1, y: 1 }, b: { x: 2, y: 1 } },
        },
      ],
    };
    const pos = emitDrawingLines(withLine)[0].positions;
    for (let i = 0; i < 4; i++) expect(pos[i * 3 + 2]).toBeGreaterThan(0);
  });
});
