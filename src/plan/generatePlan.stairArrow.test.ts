/**
 * Treppen-Pfeil-Darstellung (generatePlan → addStairSymbol): Default "line"
 * zeichnet den Auf-/Abpfeil als zwei offene Linien (cls "stair-arrow");
 * `arrowStyle:"filled"` ersetzt sie durch EIN gefülltes Dreieck-Polygon
 * (SIA-Vollpfeil).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { DrawingLevel, Project, Stair } from "../model/types";

const visible = new Set(["40"]);

const floor: DrawingLevel = {
  id: "eg",
  name: "EG",
  kind: "floor",
  visible: true,
  locked: false,
  floorHeight: 2.6,
  cutHeight: 1.0,
  baseElevation: 0,
};

function baseStair(extra: Partial<Stair> = {}): Stair {
  return {
    id: "st-1",
    type: "stair",
    floorId: "eg",
    categoryCode: "40",
    shape: "gerade",
    start: { x: 0, y: 0 },
    dir: { x: 1, y: 0 },
    runLength: 4,
    width: 1.2,
    stepCount: 16,
    totalRise: 2.6,
    ...extra,
  } as Stair;
}

function project(stair: Stair): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [floor],
    layers: [{ code: "40", name: "Treppen", color: "#333", lw: 0.18, visible: true, locked: false }],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [stair],
    rooms: [],
    drawings2d: [],
    context: [],
  } as unknown as Project;
}

describe("generatePlan — Treppen-Pfeil", () => {
  it("Default: offener Winkelpfeil = zwei stair-arrow-Linien, kein gefülltes Polygon", () => {
    const prims = generatePlan(project(baseStair()), "eg", visible).primitives;
    const arrowLines = prims.filter((p) => p.kind === "line" && p.cls === "stair-arrow");
    expect(arrowLines.length).toBe(2);
    // Keine gefüllte Pfeil-Fläche (Tritt-Polygone tragen fill:"none").
    const filled = prims.filter(
      (p) => p.kind === "polygon" && p.stairId === "st-1" && p.fill !== "none",
    );
    expect(filled.length).toBe(0);
  });

  it("filled: ein gefülltes Dreieck-Polygon, keine stair-arrow-Linien", () => {
    const prims = generatePlan(project(baseStair({ arrowStyle: "filled" })), "eg", visible)
      .primitives;
    expect(prims.some((p) => p.kind === "line" && p.cls === "stair-arrow")).toBe(false);
    const filled = prims.filter(
      (p) => p.kind === "polygon" && p.stairId === "st-1" && p.fill !== "none",
    );
    expect(filled.length).toBe(1);
    expect(filled[0].kind === "polygon" && filled[0].pts.length).toBe(3);
  });
});
