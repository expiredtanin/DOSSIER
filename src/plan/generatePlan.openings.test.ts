/**
 * Unit-Tests für die Öffnungs-Symbole im Grundriss (generatePlan):
 *  • Item 5 — Fenster Flügel-Mittelpfosten: bei wingCount=3 werden genau 2
 *    Pfosten-Linien (Querlinien) erzeugt; wingCount=1/undefined ⇒ keine.
 *  • Item 6 — Tür-Typ „wandoeffnung": kein Türblatt, kein Schwenkbogen (arc);
 *    „normal" (Default) zeichnet Blatt + Bogen wie bisher.
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Opening, Project, Wall } from "../model/types";

/** Minimalprojekt mit einer Wand + einer Öffnung, konfigurierbar. */
function projectWithOpening(opening: Opening): Project {
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
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.3 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [
      { code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
      { code: "21", name: "Öffnungen", color: "#0a0a0a", lw: 0.3, visible: true, locked: false },
    ],
    walls: [wall],
    doors: [],
    openings: [opening],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

const visible = new Set(["20", "21"]);

/** Basis-Fenster (Brüstung 0, damit keine Sill-Linie mitzählt). */
const baseWindow: Opening = {
  id: "F1",
  type: "opening",
  hostWallId: "W1",
  categoryCode: "21",
  kind: "window",
  position: 1.0,
  width: 1.6,
  height: 1.2,
  sillHeight: 0,
};

/** Basis-Tür. */
const baseDoor: Opening = {
  id: "T1",
  type: "opening",
  hostWallId: "W1",
  categoryCode: "21",
  kind: "door",
  position: 1.0,
  width: 0.9,
  height: 2.0,
  sillHeight: 0,
  swing: "left",
  hinge: "start",
};

/** Zählt Mittelpfosten-Linien (cls "window-mullion") im Plan. */
const mullionCount = (p: Project) =>
  generatePlan(p, "eg", visible, undefined, "mittel").primitives.filter(
    (pr) => pr.kind === "line" && pr.cls === "window-mullion",
  ).length;

describe("generatePlan — Fenster Flügel-Mittelpfosten (Item 5)", () => {
  it("wingCount=3 erzeugt genau 2 Pfosten-Linien", () => {
    expect(mullionCount(projectWithOpening({ ...baseWindow, wingCount: 3 }))).toBe(2);
  });

  it("wingCount=1 erzeugt keine Pfosten", () => {
    expect(mullionCount(projectWithOpening({ ...baseWindow, wingCount: 1 }))).toBe(0);
  });

  it("ohne wingCount (Default) keine Pfosten — rückwärtskompatibel", () => {
    expect(mullionCount(projectWithOpening({ ...baseWindow }))).toBe(0);
  });

  it("wingCount=4 erzeugt 3 Pfosten", () => {
    expect(mullionCount(projectWithOpening({ ...baseWindow, wingCount: 4 }))).toBe(3);
  });

  it("Pfosten sind reine Linien ohne Strichmuster (kein dash)", () => {
    const plan = generatePlan(projectWithOpening({ ...baseWindow, wingCount: 3 }), "eg", visible, undefined, "mittel");
    const mullions = plan.primitives.filter(
      (pr) => pr.kind === "line" && pr.cls === "window-mullion",
    );
    for (const m of mullions) {
      expect((m as { dash?: number[] | null }).dash ?? null).toBeNull();
    }
  });

  it("bei grob keine Pfosten (nur mittel/fein)", () => {
    const plan = generatePlan(projectWithOpening({ ...baseWindow, wingCount: 3 }), "eg", visible, undefined, "grob");
    const n = plan.primitives.filter((pr) => pr.kind === "line" && pr.cls === "window-mullion").length;
    expect(n).toBe(0);
  });
});

describe("generatePlan — Tür-Typ wandoeffnung (Item 6)", () => {
  /** Zählt Bögen (arc-Primitive) im Plan. */
  const arcCount = (p: Project, detail: "grob" | "mittel" | "fein" = "mittel") =>
    generatePlan(p, "eg", visible, undefined, detail).primitives.filter((pr) => pr.kind === "arc").length;
  /** Zählt Türblatt-Linien (cls "door-leaf"). */
  const leafCount = (p: Project) =>
    generatePlan(p, "eg", visible, undefined, "mittel").primitives.filter(
      (pr) => pr.kind === "line" && pr.cls === "door-leaf",
    ).length;

  it("wandoeffnung erzeugt KEINE Bögen (arc)", () => {
    expect(arcCount(projectWithOpening({ ...baseDoor, doorType: "wandoeffnung" }))).toBe(0);
  });

  it("wandoeffnung erzeugt KEIN Türblatt", () => {
    expect(leafCount(projectWithOpening({ ...baseDoor, doorType: "wandoeffnung" }))).toBe(0);
  });

  it("normal (Default) erzeugt Türblatt + Schwenkbogen", () => {
    const normal = projectWithOpening({ ...baseDoor, doorType: "normal" });
    expect(leafCount(normal)).toBe(1);
    expect(arcCount(normal)).toBe(1);
  });

  it("ohne doorType (Default) verhält sich wie normal — rückwärtskompatibel", () => {
    const def = projectWithOpening({ ...baseDoor });
    expect(leafCount(def)).toBe(1);
    expect(arcCount(def)).toBe(1);
  });
});
