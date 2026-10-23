import { transformSolid } from "./extrudedSolidSpec";
import { describe, expect, it } from "vitest";
import type { ExtrudedSolid } from "../model/types";
import { extrudedSolidSpec, needsBrepPath } from "./extrudedSolidSpec";

const sq = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
const base: ExtrudedSolid = { id: "e1", type: "extrudedSolid", levelId: "eg", points: sq, height: 3 };

describe("extrudedSolidSpec", () => {
  it("Prisma ohne Besonderheiten bleibt auf dem alten Pfad", () => {
    expect(needsBrepPath(base)).toBe(false);
    expect(extrudedSolidSpec(base, 1)).toMatchObject({ kind: "extrude", z0: 1, height: 3 });
  });

  it("Eckenradius schaltet auf den B-Rep-Pfad und landet in der Spezifikation", () => {
    const s = { ...base, cornerRadius: 0.3 };
    expect(needsBrepPath(s)).toBe(true);
    expect(extrudedSolidSpec(s, 0)).toMatchObject({ kind: "extrude", cornerRadius: 0.3 });
  });

  it("Fase schaltet ebenfalls auf den B-Rep-Pfad und landet in der Spezifikation", () => {
    const s = { ...base, chamfer: 0.2 };
    expect(needsBrepPath(s)).toBe(true);
    expect(extrudedSolidSpec(s, 0)).toMatchObject({ kind: "extrude", chamfer: 0.2 });
  });

  it("Verjüngung → Loft, volle Verjüngung (Pyramide) → keine B-Rep-Beschreibung", () => {
    expect(extrudedSolidSpec({ ...base, taper: 0.5 }, 0)?.kind).toBe("loft");
    expect(extrudedSolidSpec({ ...base, taper: 1 }, 0)).toBeNull();
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
    expect(needsBrepPath(moved)).toBe(true);
    expect(extrudedSolidSpec(moved, 2.6)).toEqual({
      kind: "translate",
      v: [5, -1, 2.6],
      solid: { kind: "sphere", center: [1, 1, 1], r: 1 },
    });
  });
});

describe("transformSolid", () => {
  const body = {
    id: "b", type: "extrudedSolid", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }], height: 3,
    brep: { spec: { kind: "cuboid", min: [0, 0, 0], max: [2, 1, 3] }, origin: { x: 0, y: 0 } },
  } as never;
  it("Drehung um 90° wickelt die Spezifikation in transform", () => {
    const r = transformSolid(body, (p) => ({ x: -p.y, y: p.x }));
    const sp = r.brep!.spec as { kind: string; m: number[] };
    expect(sp.kind).toBe("transform");
    expect(sp.m.slice(0, 2)).toEqual([0, -1]);
    expect(r.brep!.origin).toEqual(r.points[0]);
  });
  it("Skalierung skaliert auch die Hoehe", () => {
    const r = transformSolid(body, (p) => ({ x: p.x * 2, y: p.y * 2 }), 2);
    expect(r.height).toBe(6);
  });
});
