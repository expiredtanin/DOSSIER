// Unit-Tests für die Wand-/Decken-Resolver: Referenzlinie (`wallReferenceOffset`) und die UK/OK der
// Decken über den Kern (`verticalExtents`, Regeln `model/helpers.rs::heights`).

import { describe, it, expect } from "vitest";
import { wallReferenceOffset } from "./wall";
import { verticalExtents } from "../geometry/grips";
import type { Ceiling, Project, Wall } from "./types";

/** Minimalprojekt mit einem Geschoss (baseElevation 0, floorHeight 2.6) und
 *  einem einschichtigen Wandtyp (0.2 m), den die Decke als Aufbau nutzt. */
function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [
      { id: "dt", name: "Decke", layers: [{ componentId: "c", thickness: 0.2 }] },
    ],
    drawingLevels: [
      {
        id: "eg",
        name: "EG",
        kind: "floor",
        visible: true,
        locked: false,
        floorHeight: 2.6,
        cutHeight: 1.0,
        baseElevation: 0,
      },
      {
        id: "og",
        name: "OG",
        kind: "floor",
        visible: true,
        locked: false,
        floorHeight: 2.6,
        cutHeight: 1.0,
        baseElevation: 2.8,
      },
    ],
    layers: [{ code: "30", name: "Decken", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
    ...overrides,
  };
}

function makeCeiling(overrides?: Partial<Ceiling>): Ceiling {
  return {
    id: "cl1",
    type: "ceiling",
    floorId: "eg",
    categoryCode: "30",
    outline: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ],
    wallTypeId: "dt",
    ...overrides,
  };
}

/** UK/OK einer Decke (Kern-Abfrage). */
const ceilingVerticalExtent = (p: Project, c: Ceiling) => verticalExtents(p, [], [c]).ceilings[0];

describe("UK/OK einer Decke", () => {
  it("ohne top/bottom: OK = Geschoss-Oberkante, UK = OK − Dicke (heutiges Verhalten)", () => {
    const project = makeProject();
    const ceiling = makeCeiling();
    const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
    expect(zTop).toBeCloseTo(2.6); // baseElevation(0) + floorHeight(2.6)
    expect(zBottom).toBeCloseTo(2.4); // zTop − thickness(0.2)
  });

  it("mit top: custom übersteuert die Oberkante; UK bleibt OK − Dicke", () => {
    const project = makeProject();
    const ceiling = makeCeiling({ top: { mode: "custom", z: 3.0 } });
    const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
    expect(zTop).toBeCloseTo(3.0);
    expect(zBottom).toBeCloseTo(2.8);
  });

  it("mit bottom: custom übersteuert die Unterkante — gewinnt über OK − Dicke", () => {
    const project = makeProject();
    const ceiling = makeCeiling({ bottom: { mode: "custom", z: 2.2 } });
    const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
    expect(zTop).toBeCloseTo(2.6); // OK unverändert (Geschoss-Default)
    expect(zBottom).toBeCloseTo(2.2); // UK-Override statt OK − Dicke (2.4)
  });

  it("mit top UND bottom: beide Overrides wirken unabhängig (Dicke wird ignoriert)", () => {
    const project = makeProject();
    const ceiling = makeCeiling({
      top: { mode: "custom", z: 5.0 },
      bottom: { mode: "custom", z: 4.5 },
    });
    const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
    expect(zTop).toBeCloseTo(5.0);
    expect(zBottom).toBeCloseTo(4.5);
  });

  it("bottom: floor bindet die Unterkante an ein Geschoss (+ optionalem offset)", () => {
    const project = makeProject();
    const ceiling = makeCeiling({ bottom: { mode: "floor", floorId: "og", offset: 0.1 } });
    const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
    expect(zTop).toBeCloseTo(2.6);
    expect(zBottom).toBeCloseTo(2.9); // baseElevation(og)=2.8 + offset(0.1)
  });
});

describe("wallReferenceOffset", () => {
  const w = (extra: Partial<Wall>): Wall => ({ referenceLine: "center", ...extra } as Wall);
  const T = 0.4; // Gesamtdicke → half = 0.2

  it("bildet die benannten Linien ab (aussen/mitte/innen)", () => {
    expect(wallReferenceOffset(w({ referenceLine: "left" }), T)).toBeCloseTo(0.2, 6);
    expect(wallReferenceOffset(w({ referenceLine: "center" }), T)).toBeCloseTo(0, 6);
    expect(wallReferenceOffset(w({ referenceLine: "right" }), T)).toBeCloseTo(-0.2, 6);
  });

  it("übersteuert die Referenzlinie mit einem freien Fugen-Versatz", () => {
    // Fuge z. B. nach einer 0.05-Aussenschale: offset = half − 0.05 = 0.15.
    expect(wallReferenceOffset(w({ referenceLine: "left", referenceOffset: 0.15 }), T)).toBeCloseTo(0.15, 6);
  });

  it("klemmt den Fugen-Versatz auf ±halbe Dicke", () => {
    expect(wallReferenceOffset(w({ referenceOffset: 5 }), T)).toBeCloseTo(0.2, 6);
    expect(wallReferenceOffset(w({ referenceOffset: -5 }), T)).toBeCloseTo(-0.2, 6);
  });
});
