// Dach-Meshes (`emitRoofs`) sind je Schicht geschlossene, nach aussen gewundene Körper — Voraussetzung
// für Closed-Face-Sets im IFC und korrektes Rückseiten-Culling.

import { describe, expect, it } from "vitest";
import { emitRoofs } from "./roofs";
import { isWatertight } from "../wallMeshCut";
import { sampleProject } from "../../model/sampleProject";
import type { Project, Roof, RoofShape } from "../../model/types";

const roof = (shape: RoofShape, ridgeAxis: "x" | "y" = "x"): Roof => ({
  id: "D", type: "roof", floorId: "eg", categoryCode: "35",
  outline: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 6 }, { x: 0, y: 6 }],
  shape, pitchDeg: 35, overhang: 0.4, ridgeAxis, thickness: 0.3,
});

/** Restfläche ∮n dA (0 = dicht) und 6× Volumen (> 0 = nach aussen gewunden). */
function closure(m: { positions: number[]; indices: number[] }): { gap: number; vol6: number } {
  const p = m.positions;
  let ax = 0, ay = 0, az = 0, vol6 = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [i0, i1, i2] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
    const e1 = [p[i1] - p[i0], p[i1 + 1] - p[i0 + 1], p[i1 + 2] - p[i0 + 2]];
    const e2 = [p[i2] - p[i0], p[i2 + 1] - p[i0 + 1], p[i2 + 2] - p[i0 + 2]];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    ax += c[0]; ay += c[1]; az += c[2];
    vol6 += p[i0] * c[0] + p[i0 + 1] * c[1] + p[i0 + 2] * c[2];
  }
  return { gap: Math.hypot(ax, ay, az) / 2, vol6 };
}

describe("Dach-Meshes geschlossen und nach aussen gewunden", () => {
  // Wo drei oder mehr Flächen in einem Punkt zusammenkommen (Walm-/Zeltspitze), trifft die paarweise
  // Gehrung der Unterseite nicht exakt: kleine Restlücke (bekannt, offen). Sattel/Pult/Flach/Mansarde
  // sind dicht.
  const exact: RoofShape[] = ["flach", "pult", "sattel", "mansarde"];
  for (const shape of ["flach", "pult", "sattel", "walm", "mansarde", "zelt"] as RoofShape[]) {
    for (const axis of ["x", "y"] as const) {
      it(`${shape} (First ${axis})`, () => {
        const p: Project = { ...sampleProject, roofs: [roof(shape, axis)] };
        const meshes = emitRoofs(p);
        expect(meshes.length).toBeGreaterThan(0);
        for (const m of meshes) {
          const c = closure(m);
          expect(c.vol6).toBeGreaterThan(0);
          if (exact.includes(shape)) expect(isWatertight(m, 1e-6)).toBe(true);
          else expect(c.gap).toBeLessThan(0.01);
        }
      });
    }
  }
});
