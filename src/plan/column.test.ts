/**
 * Unit-Tests für das Stützen-Bauteil (Column) — DOSSIER-Audit A4 Tragwerk:
 *  • 2D-Grundriss (generatePlan): eine Stütze erzeugt ein Poché-Polygon mit
 *    columnId an der richtigen Position; die Rotation dreht den Rechteck-
 *    Querschnitt.
 *  • 3D (projectToModel3d/emitColumns): eine Stütze wird zu einem Prisma-Mesh
 *    (Rechteck-Box bzw. Kreis-Prisma) mit der erwarteten vertikalen Ausdehnung.
 *  (Vertikale Lage: Rust-Tests `model/helpers.rs::heights`.)
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import { projectToModel3d } from "./toWalls3d";
import { columnFootprint } from "../geometry/column";
import type { Column, Project } from "../model/types";

/** Minimalprojekt (zwei Geschosse gestapelt) mit einer konfigurierbaren Stütze. */
function projectWithColumn(column: Column): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#c8c8cc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.3 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 3, cutHeight: 1.0, baseElevation: 0 },
      { id: "og", name: "OG", kind: "floor", visible: true, locked: false, floorHeight: 3, cutHeight: 1.0, baseElevation: 3 },
    ],
    layers: [
      { code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
      { code: "50", name: "Tragwerk", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
    ],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    columns: [column],
    drawings2d: [],
    context: [],
  };
}

const visible = new Set(["20", "50"]);

/** Basis-Stütze: Rechteck 0.4×0.2 an (2,3), Höhe 3, keine Drehung. */
const rectColumn: Column = {
  id: "C1",
  type: "column",
  floorId: "eg",
  categoryCode: "50",
  position: { x: 2, y: 3 },
  profile: { kind: "rect", width: 0.4, depth: 0.2 },
  rotation: 0,
  height: 3,
};

describe("Stütze — 2D-Grundriss (generatePlan)", () => {
  it("erzeugt ein Poché-Polygon mit columnId am Rechteck-Querschnitt", () => {
    const plan = generatePlan(projectWithColumn(rectColumn), "eg", visible);
    const polys = plan.primitives.filter(
      (p) => p.kind === "polygon" && p.columnId === "C1",
    );
    expect(polys.length).toBe(1);
    const poly = polys[0];
    if (poly.kind !== "polygon") throw new Error("kein Polygon");
    // Rechteck 0.4×0.2 um (2,3): Ecken bei x∈{1.8,2.2}, y∈{2.9,3.1}.
    const xs = poly.pts.map((p) => p.x).sort((a, b) => a - b);
    const ys = poly.pts.map((p) => p.y).sort((a, b) => a - b);
    expect(poly.pts.length).toBe(4);
    expect(xs[0]).toBeCloseTo(1.8, 6);
    expect(xs[3]).toBeCloseTo(2.2, 6);
    expect(ys[0]).toBeCloseTo(2.9, 6);
    expect(ys[3]).toBeCloseTo(3.1, 6);
  });

  it("dreht den Querschnitt um 90° (Breite/Tiefe vertauscht)", () => {
    const rotated: Column = { ...rectColumn, rotation: Math.PI / 2 };
    const plan = generatePlan(projectWithColumn(rotated), "eg", visible);
    const poly = plan.primitives.find(
      (p) => p.kind === "polygon" && p.columnId === "C1",
    );
    if (!poly || poly.kind !== "polygon") throw new Error("kein Polygon");
    // Nach 90°-Drehung: X-Ausdehnung = ±depth/2 = ±0.1, Y = ±width/2 = ±0.2.
    const xs = poly.pts.map((p) => p.x).sort((a, b) => a - b);
    const ys = poly.pts.map((p) => p.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(1.9, 6);
    expect(xs[3]).toBeCloseTo(2.1, 6);
    expect(ys[0]).toBeCloseTo(2.8, 6);
    expect(ys[3]).toBeCloseTo(3.2, 6);
  });

  it("blendet die Stütze aus, wenn Kategorie 50 unsichtbar ist", () => {
    const plan = generatePlan(projectWithColumn(rectColumn), "eg", new Set(["20"]));
    expect(plan.primitives.some((p) => p.kind === "polygon" && p.columnId)).toBe(false);
  });
});

describe("Stütze — 3D (projectToModel3d / emitColumns)", () => {
  it("erzeugt eine Rechteck-Box (8 Ecken) über die volle Höhe", () => {
    const model = projectToModel3d(projectWithColumn(rectColumn));
    const meshes = model.meshes.filter((m) => m.kind === "extrusion");
    expect(meshes.length).toBe(1);
    const mesh = meshes[0];
    // 4 Footprint-Punkte × (unten + oben) = 8 Vertices.
    expect(mesh.positions.length).toBe(8 * 3);
    // z-Werte (jedes 3. Element) liegen bei 0 (UK) und 3 (OK).
    const zs = mesh.positions.filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(0, 6);
    expect(Math.max(...zs)).toBeCloseTo(3, 6);
  });

  it("erzeugt ein tesselliertes Kreis-Prisma (64 Ecken)", () => {
    const round: Column = {
      ...rectColumn,
      profile: { kind: "round", radius: 0.15 },
    };
    const model = projectToModel3d(projectWithColumn(round));
    const mesh = model.meshes.find((m) => m.kind === "extrusion");
    if (!mesh) throw new Error("kein Prisma-Mesh");
    // 32-Eck × (unten + oben) = 64 Vertices.
    expect(mesh.positions.length).toBe(64 * 3);
  });
});

describe("Stütze — Footprint-Helfer (columnFootprint)", () => {
  it("tesselliert ein rundes Profil als 32-Eck um die Position", () => {
    const round: Column = { ...rectColumn, profile: { kind: "round", radius: 0.15 } };
    const pts = columnFootprint(round);
    expect(pts.length).toBe(32);
    // Alle Punkte liegen im Radius 0.15 um (2,3).
    for (const p of pts) {
      const d = Math.hypot(p.x - 2, p.y - 3);
      expect(d).toBeCloseTo(0.15, 6);
    }
  });
});
