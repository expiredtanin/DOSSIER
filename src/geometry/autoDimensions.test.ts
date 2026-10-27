import { describe, expect, it } from "vitest";
import { autoExteriorDimensions } from "./autoDimensions";
import type { Opening, Project, Wall } from "../model/types";

// L-förmiger Grundriss aus 0.3-m-Wänden (Achsen): (0,0)→(10,0)→(10,6)→(4,6)→(4,9)→(0,9)→(0,0).
const axis: [number, number][] = [[0, 0], [10, 0], [10, 6], [4, 6], [4, 9], [0, 9]];
function project(openings: Opening[] = []): Project {
  const walls: Wall[] = axis.map(([x, y], i) => {
    const [x2, y2] = axis[(i + 1) % axis.length];
    return { id: `W${i}`, type: "wall", floorId: "eg", categoryCode: "20", start: { x, y }, end: { x: x2, y: y2 }, wallTypeId: "aw" } as Wall;
  });
  return {
    id: "t", name: "T", lineStyles: [], hatches: [], components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 1 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "c", thickness: 0.3 }] }],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1, baseElevation: 0 }],
    layers: [], walls, openings, ceilings: [], stairs: [], rooms: [], drawings2d: [], context: [],
  } as unknown as Project;
}
const lengths = (pts: { x: number; y: number }[]) => pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

describe("automatische Aussenbemassung", () => {
  it("vier Seiten, Gesamtmass = Aussenmass", () => {
    const dims = autoExteriorDimensions(project(), "eg", "80");
    const totals = dims.filter((d) => d.chain === "total");
    expect(totals).toHaveLength(4);
    const byside = Object.fromEntries(totals.map((d) => [d.side, sum(lengths(d.drawing.geom.shape === "dimension" ? d.drawing.geom.pts : []))]));
    expect(byside.south).toBeCloseTo(10.3, 6);
    expect(byside.north).toBeCloseTo(10.3, 6);
    expect(byside.west).toBeCloseTo(9.3, 6);
    expect(byside.east).toBeCloseTo(9.3, 6);
  });
  it("Vor-/Rücksprung-Kette nur, wo die Seite gestuft ist (L: Nord und Ost)", () => {
    const dims = autoExteriorDimensions(project(), "eg", "80");
    const steps = dims.filter((d) => d.chain === "steps");
    expect(steps.map((d) => d.side).sort()).toEqual(["east", "north"]);
    const north = steps.find((d) => d.side === "north")!;
    const g = north.drawing.geom;
    expect(g.shape === "dimension" && lengths(g.pts).map((v) => +v.toFixed(3)).sort((a, b) => a - b)).toEqual([4.3, 6]);
  });
  it("Öffnungskette mit Leibungen, Abstand nach aussen positiv", () => {
    const o = { id: "F1", type: "opening", categoryCode: "21", kind: "window", hostWallId: "W0", position: 2, width: 1.5, height: 1.4, sillHeight: 0.9 } as Opening;
    const dims = autoExteriorDimensions(project([o]), "eg", "80");
    const south = dims.find((d) => d.side === "south" && d.chain === "openings")!;
    const g = south.drawing.geom;
    expect(g.shape).toBe("dimension");
    if (g.shape !== "dimension") return;
    expect(lengths(g.pts).length).toBe(3);
    expect(sum(lengths(g.pts))).toBeCloseTo(10.3, 6);
    expect(g.offset).toBeGreaterThan(0);
    // Masslinie liegt ausserhalb (südlich) des Gebäudes.
    const nx = -(g.pts[1].y - g.pts[0].y), ny = g.pts[1].x - g.pts[0].x;
    const len = Math.hypot(nx, ny);
    expect(g.pts[0].y + (ny / len) * g.offset).toBeLessThan(-0.15);
    expect(south.drawing.levelId).toBe("eg");
    expect(south.drawing.categoryCode).toBe("80");
  });
  it("ohne Wände nichts", () => {
    expect(autoExteriorDimensions({ ...project(), walls: [] }, "eg", "80")).toEqual([]);
  });
});

describe("Planbegrenzung mit Bemassung", () => {
  it("umfasst die versetzte Masslinie samt Masszahl", async () => {
    const { generatePlan } = await import("../plan/generatePlan");
    const p = project();
    const dims = autoExteriorDimensions(p, "eg", "80");
    const withDims = { ...p, layers: [{ code: "80", name: "Mass", color: "#000", lw: 0.18, visible: true, locked: false }], drawings2d: dims.map((d) => d.drawing) } as Project;
    const b = generatePlan(withDims, "eg", new Set(["80"])).bounds;
    // Gesamtmass Süd liegt 2.4 m ausserhalb von y = -0.15.
    expect(b.minY).toBeLessThan(-0.15 - 2.4);
    expect(b.maxX).toBeGreaterThan(10.15 + 2.4);
  });
});
