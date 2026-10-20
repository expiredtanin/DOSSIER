// Füllungs-Transparenz (Drawing2D.fillOpacity): trifft NUR die Flächen-Primitive,
// Umriss-Linien bleiben deckend; zusammen mit `opacity` multiplizieren sich beide.

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Drawing2D, Project } from "../model/types";

const closed = (over: Partial<Drawing2D>): Drawing2D =>
  ({
    id: "D",
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "60",
    fillColor: "#336699",
    geom: { shape: "polyline", pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], closed: true },
    ...over,
  }) as unknown as Drawing2D;

const project = (d: Drawing2D): Project =>
  ({
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "60", name: "Zeichnung", color: "#0a0a0a", lw: 0.25, visible: true, locked: false }],
    walls: [], doors: [], openings: [], ceilings: [], stairs: [], rooms: [],
    drawings2d: [d],
    context: [],
  }) as unknown as Project;

const prims = (d: Drawing2D) => generatePlan(project(d), "eg", new Set(["60"])).primitives;

describe("Füllungs-Transparenz", () => {
  it("macht nur das Polygon transparent, die Linien bleiben deckend", () => {
    const p = prims(closed({ fillOpacity: 0.4 }));
    const polys = p.filter((x) => x.kind === "polygon");
    const lines = p.filter((x) => x.kind === "line");
    expect(polys.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(polys.every((x) => (x as { opacity?: number }).opacity === 0.4)).toBe(true);
    expect(lines.every((x) => (x as { opacity?: number }).opacity === undefined)).toBe(true);
  });

  it("ohne fillOpacity bleibt alles unverändert", () => {
    const p = prims(closed({}));
    expect(p.filter((x) => x.kind === "polygon").every((x) => (x as { opacity?: number }).opacity === undefined)).toBe(true);
  });

  it("multipliziert sich mit der Objekt-Deckkraft", () => {
    const p = prims(closed({ opacity: 0.5, fillOpacity: 0.5 }));
    const polys = p.filter((x) => x.kind === "polygon");
    expect(polys.every((x) => Math.abs(((x as { opacity?: number }).opacity ?? 1) - 0.25) < 1e-9)).toBe(true);
    const lines = p.filter((x) => x.kind === "line");
    expect(lines.every((x) => (x as { opacity?: number }).opacity === 0.5)).toBe(true);
  });
});
