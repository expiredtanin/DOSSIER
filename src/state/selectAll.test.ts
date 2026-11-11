// [193] Cmd+A: Kontext-Elemente (Gelände, Höhenlinien, Baugrube, Netze, Bilder) gehören dazu — sichtbare, nicht gesperrte Klasse.
import { beforeAll, describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { setCategoriesVisible, patchCategoryByCode } from "../model/layers";
import { selectAllIds, selectAllHasAny } from "./selectAll";
import type { Project } from "../model/types";

let p: Project;
beforeAll(() => {
  p = buildComplexSampleProject();
});

describe("selectAllIds", () => {
  it("nimmt Gelände, Höhenlinien und Baugrube mit", () => {
    const ids = selectAllIds(p, "eg");
    const all = new Set(ids.contextObjects);
    for (const type of ["terrainMesh", "contourSet", "excavation"] as const) {
      const c = (p.context ?? []).filter((o) => o.type === type);
      expect(c.length, type).toBeGreaterThan(0);
      for (const o of c) expect(all.has(o.id), `${type} ${o.id}`).toBe(true);
    }
    expect(ids.walls!.length).toBeGreaterThan(0);
    expect(selectAllHasAny(ids)).toBe(true);
  });

  it("wählt die Schattenfläche der Sonnenstudie (Entf blendet sie aus), nur im Geschoss-Grundriss", () => {
    expect(p.sunStudy?.show).toBe(true);
    expect(selectAllIds(p, "eg").site).toEqual(["sunStudy"]);
    expect(selectAllIds(p, "schnitt-a").site).toEqual([]);
    const q = { ...p, sunStudy: { ...p.sunStudy!, show: false } };
    expect(selectAllIds(q, "eg").site).toEqual([]);
  });

  it("lässt Kontext mit ausgeblendeter Klasse aus", () => {
    const ctx = p.context![0];
    const q = { ...p, layers: setCategoriesVisible(p.layers, new Set([ctx.categoryCode]), false) };
    expect(selectAllIds(q, "eg").contextObjects).not.toContain(ctx.id);
    expect(selectAllIds(q, "eg").contextObjects!.length).toBeLessThan(selectAllIds(p, "eg").contextObjects!.length);
  });

  it("lässt Kontext mit gesperrter Klasse aus", () => {
    const ctx = p.context![0];
    const q = { ...p, layers: patchCategoryByCode(p.layers, ctx.categoryCode, { locked: true }) };
    expect(selectAllIds(q, "eg").contextObjects).not.toContain(ctx.id);
  });

  it("andere Geschosse bleiben aussen vor", () => {
    const ids = selectAllIds(p, "eg");
    const ogWall = p.walls.find((w) => w.floorId === "og")!;
    expect(ids.walls).not.toContain(ogWall.id);
  });
});
