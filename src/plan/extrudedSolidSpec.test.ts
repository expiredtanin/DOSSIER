import { describe, expect, it } from "vitest";
import type { ExtrudedSolid } from "../model/types";
import { extrudedSolidSpec } from "./extrudedSolidSpec";

const sq = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
const base: ExtrudedSolid = { id: "e1", type: "extrudedSolid", categoryCode: "20", levelId: "eg", points: sq, height: 3 };

describe("extrudedSolidSpec", () => {
  it("Prisma ohne Besonderheiten: einfache Extrusion", () => {
    expect(extrudedSolidSpec(base, 1)).toMatchObject({ kind: "extrude", z0: 1, height: 3 });
  });

  it("Eckenradius landet in der Spezifikation", () => {
    const s = { ...base, cornerRadius: 0.3 };
    expect(extrudedSolidSpec(s, 0)).toMatchObject({ kind: "extrude", cornerRadius: 0.3 });
  });

  it("Fase landet in der Spezifikation", () => {
    const s = { ...base, chamfer: 0.2 };
    expect(extrudedSolidSpec(s, 0)).toMatchObject({ kind: "extrude", chamfer: 0.2 });
  });

  it("Verjüngung → Loft, volle Verjüngung → Pyramide als Netz ([115])", () => {
    expect(extrudedSolidSpec({ ...base, taper: 0.5 }, 0)?.kind).toBe("loft");
    expect(extrudedSolidSpec({ ...base, taper: 1 }, 0)).toMatchObject({ kind: "mesh", positions: [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 1, 1, 3] });
  });

  it("Kreisprofil → Zylinder bzw. Kegel", () => {
    const c = { ...base, circle: { center: { x: 1, y: 1 }, r: 1 } };
    expect(extrudedSolidSpec(c, 0)?.kind).toBe("cylinder");
    expect(extrudedSolidSpec({ ...c, taper: 1 }, 0)?.kind).toBe("cone");
  });

  it("Grundkörper (brep): Verschiebung ergibt sich aus points[0] − origin, UK = baseZ", () => {
    const moved: ExtrudedSolid = {
      ...base,
      points: sq.map((p) => ({ x: p.x + 5, y: p.y - 1 })),
      brep: { spec: { kind: "sphere", center: [1, 1, 1], r: 1 }, origin: { x: 0, y: 0 } },
    };
    expect(extrudedSolidSpec(moved, 2.6)).toEqual({
      kind: "translate",
      v: [5, -1, 2.6],
      solid: { kind: "sphere", center: [1, 1, 1], r: 1 },
    });
  });
});
