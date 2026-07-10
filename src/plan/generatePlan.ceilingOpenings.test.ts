/**
 * Unit-Tests für Decken-Aussparungen (Treppenauge/Schacht) im Grundriss
 * (generatePlan → addCeilingPoche): der Brücken-Trick (mergeHoles) fügt das
 * Loch als EINEN erweiterten Poché-Ring ein.
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Ceiling, Project } from "../model/types";
import type { Primitive } from "./generatePlan";

/** Minimalprojekt mit EINER Decke (6x4m), konfigurierbarem `openings`. */
function projectWithCeiling(openings?: Ceiling["openings"]): Project {
  const ceiling: Ceiling = {
    id: "C1",
    type: "ceiling",
    floorId: "eg",
    categoryCode: "30",
    outline: [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 0, y: 4 },
    ],
    wallTypeId: "aw",
    ...(openings ? { openings } : {}),
  };
  return {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.3 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "30", name: "Decken", color: "#0a0a0a", lw: 0.3, visible: true, locked: false }],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [ceiling],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

const visible = new Set(["30"]);

const plan = (p: Project) => generatePlan(p, "eg", visible, undefined, "mittel");

/** Die Poché-Fläche der Decke (Fill-Polygon mit `ceilingId`). */
const pochePrim = (primitives: Primitive[]) =>
  primitives.find((pr): pr is Extract<Primitive, { kind: "polygon" }> => pr.kind === "polygon" && pr.ceilingId === "C1");

const outlineLineCount = (primitives: Primitive[]) =>
  primitives.filter((pr) => pr.kind === "line" && pr.cls === "ceiling-outline").length;

describe("generatePlan — Decken-Aussparungen (Brücken-Trick)", () => {
  it("ohne openings: Poché-Polygon = unveränderte Outline, kein noStrokeEdges (Regression)", () => {
    const p = projectWithCeiling(undefined);
    const prims = plan(p).primitives;
    const poche = pochePrim(prims);
    expect(poche).toBeDefined();
    expect(poche!.pts).toEqual(p.ceilings![0].outline);
    expect(poche!.noStrokeEdges).toBeUndefined();
    expect("noStrokeEdges" in poche!).toBe(false);
    // 4 Aussenkanten, keine Wände im Testprojekt -> 4 volle Umrisslinien.
    expect(outlineLineCount(prims)).toBe(4);
  });

  it("mit einem 1x1-Loch mittig: Poché-Polygon hat mehr Ecken, noStrokeEdges = Brückenkanten", () => {
    const hole = [
      { x: 2.5, y: 1.5 },
      { x: 3.5, y: 1.5 },
      { x: 3.5, y: 2.5 },
      { x: 2.5, y: 2.5 },
    ];
    const p = projectWithCeiling([hole]);
    const prims = plan(p).primitives;
    const poche = pochePrim(prims);
    expect(poche).toBeDefined();
    // 4 (Aussen) + 4 (Loch) + 2 (Brücken-Duplikate) = 10 Ecken.
    expect(poche!.pts.length).toBe(10);
    expect(poche!.pts.length).toBeGreaterThan(p.ceilings![0].outline.length);
    expect(poche!.noStrokeEdges).toBeDefined();
    expect(poche!.noStrokeEdges!.length).toBe(2);

    // Die Brückenkanten selbst tragen keine Umrisslinie; der Rest (8 Kanten:
    // 4 Aussen + 4 Lochrand) wird gestrichen — der Lochrand erscheint als
    // eigenständige Umrisslinien, obwohl `ceiling.outline` unverändert blieb.
    expect(outlineLineCount(prims)).toBe(poche!.pts.length - poche!.noStrokeEdges!.length);
    expect(outlineLineCount(prims)).toBe(8);
  });

  it("Loch ausserhalb der Outline wird ignoriert (Poché bleibt unverändert)", () => {
    const outsideHole = [
      { x: 20, y: 20 },
      { x: 21, y: 20 },
      { x: 21, y: 21 },
      { x: 20, y: 21 },
    ];
    const p = projectWithCeiling([outsideHole]);
    const prims = plan(p).primitives;
    const poche = pochePrim(prims);
    expect(poche!.pts).toEqual(p.ceilings![0].outline);
    expect("noStrokeEdges" in poche!).toBe(false);
    expect(outlineLineCount(prims)).toBe(4);
  });
});
