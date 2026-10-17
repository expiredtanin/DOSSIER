import { describe, expect, it } from "vitest";
import type { Project } from "../../model/types";
import { sampleProject } from "../../model/sampleProject";
import { emitDrawingLineVerts } from "./drawing2d";

// `emitDrawingLineVerts` liefert die 2D-Boden-Spuren als LineList-Vertices für
// render3ds `set_drawing_lines` (binärer Float32Array-Kanal) — interleaved
// `[px, py, pz, r, g, b]` in WORLD-Metern, je 2 Vertices ein Segment.
//
// Vorher war das je Zeichnung ein Ribbon-MESH im JSON-Modell; das scheiterte
// bei einem Kataster-Import (Nutzer-Report 2026-10-08, ~3,6 Mio. Segmente)
// hart an der JS-String-Längengrenze. Zwei Eigenschaften sind daher
// regressionskritisch und hier abgedeckt: die WORLD-Abbildung (Modell
// `(x, y, z=Höhe)` → world `(x, Höhe, y)`, OHNE Nord-Negation — das war der
// Mirror-Bug 2026-09-27) und die exakte Puffergrösse.

const FLOATS_PER_VERTEX = 6;

function projectWith(drawings: Project["drawings2d"]): Project {
  return { ...sampleProject, drawings2d: drawings };
}

describe("emitDrawingLineVerts — WORLD-Abbildung und Puffergrösse", () => {
  it("bildet Modell (x, y) auf world (x, Höhe, y) ab — KEINE Nord-Negation", () => {
    const p = projectWith([
      {
        id: "D1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        // Reine "Nord"-Linie: model (0,0) → (0,5).
        geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 0, y: 5 } },
      },
    ] as unknown as Project["drawings2d"]);

    const v = emitDrawingLineVerts(p);
    // Ein Segment = 2 Vertices × 6 Floats.
    expect(v.length).toBe(2 * FLOATS_PER_VERTEX);
    // Vertex 0 = Startpunkt: world.x = model.x, world.z = model.y (NICHT -y).
    expect(v[0]).toBeCloseTo(0, 6); // px
    expect(v[2]).toBeCloseTo(0, 6); // pz (= model y)
    // Vertex 1 = Endpunkt: world.z muss +5 sein (negiert wäre der Mirror-Bug).
    expect(v[FLOATS_PER_VERTEX + 0]).toBeCloseTo(0, 6); // px
    expect(v[FLOATS_PER_VERTEX + 2]).toBeCloseTo(5, 6); // pz
  });

  it("legt die Spur knapp ÜBER die Geschossebene (Höhe = world-y, positiv)", () => {
    const p = projectWith([
      {
        id: "D1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: { shape: "line", a: { x: 1, y: 1 }, b: { x: 2, y: 1 } },
      },
    ] as unknown as Project["drawings2d"]);

    const v = emitDrawingLineVerts(p);
    // Beide Vertices tragen dieselbe, positive Höhe (Index 1 = world y).
    expect(v[1]).toBeGreaterThan(0);
    expect(v[FLOATS_PER_VERTEX + 1]).toBeCloseTo(v[1], 6);
  });

  it("dimensioniert den Puffer exakt: n Segmente → n × 2 × 6 Floats", () => {
    // Offene Polylinie mit 5 Punkten = 4 Segmente; dazu eine Linie = 1 Segment.
    const p = projectWith([
      {
        id: "P1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: {
          shape: "polyline",
          pts: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 },
            { x: 3, y: 0 },
            { x: 4, y: 0 },
          ],
          closed: false,
        },
      },
      {
        id: "L1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: { shape: "line", a: { x: 0, y: 9 }, b: { x: 1, y: 9 } },
      },
    ] as unknown as Project["drawings2d"]);

    expect(emitDrawingLineVerts(p).length).toBe(5 * 2 * FLOATS_PER_VERTEX);
  });

  it("geschlossene Polylinie bekommt das Schlusssegment (Vorab-Zählung stimmt mit der Emission überein)", () => {
    const closed = projectWith([
      {
        id: "P1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: {
          shape: "polyline",
          pts: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
          ],
          closed: true,
        },
      },
    ] as unknown as Project["drawings2d"]);
    // 3 Punkte geschlossen = 3 Segmente (2 offen + 1 Schluss).
    expect(emitDrawingLineVerts(closed).length).toBe(3 * 2 * FLOATS_PER_VERTEX);
  });

  it("Rechteck liefert vier Segmente", () => {
    const p = projectWith([
      {
        id: "R1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: { shape: "rect", min: { x: 0, y: 0 }, max: { x: 2, y: 1 } },
      },
    ] as unknown as Project["drawings2d"]);
    expect(emitDrawingLineVerts(p).length).toBe(4 * 2 * FLOATS_PER_VERTEX);
  });

  it("entartete (nullängige) Segmente werden übersprungen, der Puffer entsprechend gekürzt", () => {
    const p = projectWith([
      {
        id: "P1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        geom: {
          shape: "polyline",
          // Mittlerer Punkt doppelt → ein Segment der Länge 0.
          pts: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 },
          ],
          closed: false,
        },
      },
    ] as unknown as Project["drawings2d"]);
    // 3 Segmente gezählt, nur 2 emittiert.
    expect(emitDrawingLineVerts(p).length).toBe(2 * 2 * FLOATS_PER_VERTEX);
  });

  it("ohne 2D-Zeichnungen: leerer Puffer (löscht die Unterlage in render3d)", () => {
    expect(emitDrawingLineVerts(projectWith([])).length).toBe(0);
  });

  it("explizite Elementfarbe landet als 0..1-RGB an beiden Vertices", () => {
    const p = projectWith([
      {
        id: "D1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "2d-line",
        color: "#ff0000",
        geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
      },
    ] as unknown as Project["drawings2d"]);

    const v = emitDrawingLineVerts(p);
    expect(v[3]).toBeCloseTo(1, 5); // r
    expect(v[4]).toBeCloseTo(0, 5); // g
    expect(v[5]).toBeCloseTo(0, 5); // b
    // Zweiter Vertex trägt dieselbe Farbe.
    expect(v[FLOATS_PER_VERTEX + 3]).toBeCloseTo(1, 5);
  });
});
