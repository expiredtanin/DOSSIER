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

/** Zählt Fenster-Anschlag-/Laibungsstriche (cls "window-frame") im Plan. */
function windowRevealCount(p: Project, detail: "grob" | "mittel" | "fein") {
  return generatePlan(p, "eg", visible, undefined, detail).primitives.filter(
    (pr) => pr.kind === "line" && pr.cls === "window-frame",
  ).length;
}

describe("generatePlan — Fenster Anschlag-Striche (Item 8)", () => {
  it("erzeugt bei 'fein' zwei Laibungsstriche (je Pfosten einen)", () => {
    expect(windowRevealCount(projectWithOpening({ ...baseWindow }), "fein")).toBe(2);
  });

  it("erzeugt bei 'mittel' KEINE (nur im Detailgrad fein)", () => {
    expect(windowRevealCount(projectWithOpening({ ...baseWindow }), "mittel")).toBe(0);
  });
});

describe("generatePlan — Opening.detailLevel (Per-Element-Übersteuerung der Ansichts-Detailstufe)", () => {
  /** Zählt Schwenkbögen (arc) für eine Tür bei einer gegebenen ANSICHTS-Detailstufe. */
  const doorArcCount = (opening: Opening, viewDetail: "grob" | "mittel" | "fein") =>
    generatePlan(projectWithOpening(opening), "eg", visible, undefined, viewDetail).primitives.filter(
      (pr) => pr.kind === "arc",
    ).length;

  it("ohne detailLevel gilt weiterhin die Ansichts-Detailstufe (rückwärtskompatibel)", () => {
    expect(doorArcCount(baseDoor, "grob")).toBe(0); // grob: kein Schwenkbogen
    expect(doorArcCount(baseDoor, "mittel")).toBe(1); // mittel+: Schwenkbogen
  });

  it("detailLevel='grob' unterdrückt den Schwenkbogen, AUCH wenn die Ansicht 'fein' zeigt", () => {
    expect(doorArcCount({ ...baseDoor, detailLevel: "grob" }, "fein")).toBe(0);
  });

  it("detailLevel='fein' zeigt den Schwenkbogen, AUCH wenn die Ansicht 'grob' zeigt", () => {
    expect(doorArcCount({ ...baseDoor, detailLevel: "fein" }, "grob")).toBe(1);
  });

  it("wirkt NUR auf die übersteuerte Öffnung, andere Öffnungen bleiben bei der Ansichts-Detailstufe", () => {
    const wall: Wall = {
      id: "W1",
      type: "wall",
      floorId: "eg",
      categoryCode: "20",
      start: { x: 0, y: 0 },
      end: { x: 6, y: 0 },
      wallTypeId: "aw",
      height: 2.6,
    };
    const doorFein: Opening = { ...baseDoor, id: "T1", detailLevel: "fein" };
    const doorPlain: Opening = { ...baseDoor, id: "T2", position: 3.0 };
    const p: Project = { ...projectWithOpening(doorFein), walls: [wall], openings: [doorFein, doorPlain] };
    const plan = generatePlan(p, "eg", visible, undefined, "grob");
    expect(plan.primitives.filter((pr) => pr.kind === "arc").length).toBe(1);
  });
});
