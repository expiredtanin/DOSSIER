// Integrations-Tests: der Grundriss-Pfad (generatePlan) wendet die grafischen
// Override-Regeln (Project.overrideRules) als OBERSTE Schicht über der
// By-Layer/By-Object-Auflösung an — als reines Rendering-Overlay (die
// Elementdaten bleiben unverändert).

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { OverrideRule, Project, Wall } from "../model/types";

/** Minimalprojekt: eine Wand (Ebene „Wände"/20) + eine 2D-Linie (Ebene 60). */
function project(overrideRules?: OverrideRule[]): Project {
  const wall: Wall = {
    id: "W1",
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start: { x: 0, y: 0 },
    end: { x: 4, y: 0 },
    wallTypeId: "aw",
    height: 2.6,
  };
  return {
    id: "t",
    name: "T",
    lineStyles: [
      { id: "dashed", name: "Gestrichelt", weight: 0.13, color: "#111", dash: [2, 1] },
    ],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW Beton", layers: [{ componentId: "a", thickness: 0.2 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [
      { code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
      { code: "60", name: "Zeichnung", color: "#0a0a0a", lw: 0.25, visible: true, locked: false },
    ],
    walls: [wall],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [
      {
        id: "D1",
        type: "drawing2d",
        levelId: "eg",
        categoryCode: "60",
        geom: { shape: "line", a: { x: 0, y: 1 }, b: { x: 2, y: 1 } },
      },
    ],
    context: [],
    overrideRules,
  };
}

const visible = new Set(["20", "60"]);

/** Alle Polygone der Wand W1 (grob = eine Sammelfläche mit Umriss). */
function wallPolys(p: ReturnType<typeof generatePlan>) {
  return p.primitives.filter(
    (pr): pr is Extract<typeof pr, { kind: "polygon" }> =>
      pr.kind === "polygon" && pr.wallId === "W1",
  );
}

/** Die Linien-Primitive des 2D-Elements D1. */
function drawingLines(p: ReturnType<typeof generatePlan>) {
  return p.primitives.filter(
    (pr): pr is Extract<typeof pr, { kind: "line" }> =>
      pr.kind === "line" && pr.drawingId === "D1",
  );
}

describe("generatePlan — grafische Overrides (Regel-Engine)", () => {
  it("layer_name-Regel färbt die Wand-Umrisslinie um (Farbe-Aktion)", () => {
    const rules: OverrideRule[] = [
      {
        id: "r1",
        name: "Wände rot",
        enabled: true,
        condition: { type: "layer_name", operator: "equals", value: "Wände" },
        actions: { color: "#ff0000" },
      },
    ];
    const plan = generatePlan(project(rules), "eg", visible, undefined, "grob");
    const polys = wallPolys(plan);
    expect(polys.length).toBeGreaterThan(0);
    expect(polys.every((p) => p.stroke === "#ff0000")).toBe(true);
  });

  it("Lineweight-Regel wirkt identisch zum expliziten Attribut-Override", () => {
    const rules: OverrideRule[] = [
      {
        id: "r1",
        name: "Wände dick",
        enabled: true,
        condition: { type: "layer_name", operator: "equals", value: "20" },
        actions: { lineweight: 0.7 },
      },
    ];
    const withRule = generatePlan(project(rules), "eg", visible, undefined, "grob");
    // Referenz: dieselbe Strichstärke direkt als Element-Attribut gesetzt.
    const ref = project();
    ref.walls[0].strokeWeight = 0.7;
    const withAttr = generatePlan(ref, "eg", visible, undefined, "grob");
    expect(wallPolys(withRule).map((p) => p.strokeWidthMm)).toEqual(
      wallPolys(withAttr).map((p) => p.strokeWidthMm),
    );
    // Und unterscheidet sich vom Plan ohne Regel (Regel wirkt tatsächlich).
    const base = generatePlan(project(), "eg", visible, undefined, "grob");
    expect(wallPolys(withRule)[0].strokeWidthMm).not.toBe(
      wallPolys(base)[0].strokeWidthMm,
    );
  });

  it("deaktivierte Regel wirkt nicht (Standard-Strich bleibt)", () => {
    const rules: OverrideRule[] = [
      {
        id: "r1",
        name: "Wände rot (aus)",
        enabled: false,
        condition: { type: "layer_name", operator: "equals", value: "Wände" },
        actions: { color: "#ff0000" },
      },
    ];
    const plan = generatePlan(project(rules), "eg", visible, undefined, "grob");
    expect(wallPolys(plan).some((p) => p.stroke === "#ff0000")).toBe(false);
  });

  it("Regel-Override gewinnt über den Per-Instanz-Farbwert (oberste Schicht)", () => {
    const rules: OverrideRule[] = [
      {
        id: "r1",
        name: "Wände rot",
        enabled: true,
        condition: { type: "layer_name", operator: "equals", value: "Wände" },
        actions: { color: "#ff0000" },
      },
    ];
    const p = project(rules);
    p.walls[0].color = "#00ff00"; // Instanz-Farbe — die Regel liegt darüber.
    const plan = generatePlan(p, "eg", visible, undefined, "grob");
    expect(wallPolys(plan).every((pr) => pr.stroke === "#ff0000")).toBe(true);
  });

  it("object_name-Regel + Linienstil-Aktion: 2D-Linie erhält das Strichmuster", () => {
    const rules: OverrideRule[] = [
      {
        id: "r1",
        name: "Linien gestrichelt",
        enabled: true,
        condition: { type: "object_name", operator: "equals", value: "line" },
        actions: { linetypeId: "dashed", color: "#ff00ff" },
      },
    ];
    const plan = generatePlan(project(rules), "eg", visible, undefined, "mittel");
    const lines = drawingLines(plan);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.color === "#ff00ff")).toBe(true);
    expect(lines.every((l) => Array.isArray(l.dash) && l.dash.length === 2)).toBe(true);
  });

  it("reines Rendering-Overlay: die Projektdaten bleiben unverändert", () => {
    const rules: OverrideRule[] = [
      {
        id: "r1",
        name: "Alles rot",
        enabled: true,
        condition: { type: "layer_name", operator: "contains", value: "" },
        actions: { color: "#ff0000", lineweight: 1.0 },
      },
    ];
    const p = project(rules);
    generatePlan(p, "eg", visible, undefined, "grob");
    expect(p.walls[0].color).toBeUndefined();
    expect(p.walls[0].strokeWeight).toBeUndefined();
    expect(p.drawings2d[0].lineStyleId).toBeUndefined();
  });
});
