/**
 * Unit-Tests für „Schnitt vs. Ansicht nach Schnitthöhe" (generatePlan):
 * Eine Wand, die die Grundriss-Schnittebene NICHT erreicht (Höhe < `cutHeight`,
 * z. B. eine Brüstung), wird nur als Ansichts-Umriss gezeichnet — Poché-Polygone
 * OHNE Füllung (`fill:"none"`), keine Schraffur. Eine normale Wand (Höhe ≥
 * Schnitthöhe) behält die geschnittene Poché (gefüllte Bänder).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Project, Wall } from "../model/types";

/** Minimalprojekt: eine normale Wand (2.6 m) + eine niedrige Wand (0.3 m). */
function project(): Project {
  const wall = (id: string, start: Wall["start"], end: Wall["end"], height: number): Wall => ({
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "aw",
    height,
  });
  return {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.2 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [
      wall("HI", { x: 0, y: 0 }, { x: 4, y: 0 }, 2.6), // erreicht Schnitt → Poché
      wall("LOW", { x: 0, y: 2 }, { x: 4, y: 2 }, 0.3), // Brüstung → nur Ansicht
    ],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

const visible = new Set(["20"]);

describe("generatePlan — Schnitt vs. Ansicht nach Schnitthöhe", () => {
  it("zeichnet die niedrige Wand nur als Ansichts-Umriss (fill none), die normale mit Poché", () => {
    const plan = generatePlan(project(), "eg", visible, undefined, "mittel");
    const wallPolys = (id: string) =>
      plan.primitives.filter(
        (p): p is Extract<typeof p, { kind: "polygon" }> =>
          p.kind === "polygon" && p.wallId === id,
      );

    const hi = wallPolys("HI");
    const low = wallPolys("LOW");
    expect(hi.length).toBeGreaterThan(0);
    expect(low.length).toBeGreaterThan(0);

    // Normale Wand: mindestens ein gefülltes Poché-Band (Bauteil-Farbe).
    expect(hi.some((p) => p.fill !== "none")).toBe(true);
    // Niedrige Wand: ALLE Polygone ohne Füllung (reiner Ansichts-Umriss).
    expect(low.every((p) => p.fill === "none")).toBe(true);
  });

  it("behandelt die niedrige Wand als geschnitten, wenn die Schnitthöhe darunter liegt", () => {
    const p = project();
    p.drawingLevels[0].cutHeight = 0.2; // Schnittebene unter 0.3 m → auch LOW geschnitten
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const low = plan.primitives.filter(
      (pr): pr is Extract<typeof pr, { kind: "polygon" }> =>
        pr.kind === "polygon" && pr.wallId === "LOW",
    );
    expect(low.some((pr) => pr.fill !== "none")).toBe(true);
  });

  // Regression: `wall.bottom`/`wall.top` (VerticalAnchor-Override) muss die
  // Schnitt-vs-Ansicht-Entscheidung über die ECHTE vertikale Ausdehnung
  // (`wallVerticalExtent`) treffen, nicht nur über `wall.height` — sonst
  // rutscht eine hochgesetzte Wand fälschlich in die falsche Kategorie.
  it("behandelt eine hochgesetzte Wand (bottom-Override ÜBER der Schnittebene) als Ansicht, obwohl ihre Höhe allein 'hoch genug' aussieht", () => {
    const p = project();
    // HI (2.6 m hoch) auf ein UK von 1.5 m angehoben → Spanne [1.5, 4.1],
    // Schnittebene bei 1.0 m liegt UNTER der Wand → reine Ansicht erwartet.
    p.walls[0].bottom = { mode: "custom", z: 1.5 };
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const hi = plan.primitives.filter(
      (pr): pr is Extract<typeof pr, { kind: "polygon" }> =>
        pr.kind === "polygon" && pr.wallId === "HI",
    );
    expect(hi.length).toBeGreaterThan(0);
    expect(hi.every((pr) => pr.fill === "none")).toBe(true);
  });

  it("behandelt eine hochgesetzte Wand als geschnitten, wenn die Schnittebene weiterhin in ihrer Spanne liegt", () => {
    const p = project();
    // HI von [1.5, 4.1] angehoben, Schnittebene mit angehoben auf 2.0 m → liegt
    // weiterhin INNERHALB der Wand-Spanne → Poché erwartet.
    p.walls[0].bottom = { mode: "custom", z: 1.5 };
    p.drawingLevels[0].cutHeight = 2.0;
    const plan = generatePlan(p, "eg", visible, undefined, "mittel");
    const hi = plan.primitives.filter(
      (pr): pr is Extract<typeof pr, { kind: "polygon" }> =>
        pr.kind === "polygon" && pr.wallId === "HI",
    );
    expect(hi.length).toBeGreaterThan(0);
    expect(hi.some((pr) => pr.fill !== "none")).toBe(true);
  });
});

// ── Decke über der Schnittebene → gestrichelte Überkopf-Umrisslinie ──────────

// ── grob (1:100) → Wand-Poché IMMER vollschwarz (SIA 400 Fig. 36) ──────────

/** Minimalprojekt mit einer Wand, deren Bauteil ein NICHT-"solid" Hatch-Pattern
 *  hat (Backstein/diagonal — der Normalfall bei mehrschichtigen Wandtypen). */
function nonSolidWallProject(): Project {
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
    hatches: [{ id: "diag", name: "Diagonal", pattern: "diagonal", scale: 1, angle: 45, color: "#111" }],
    components: [{ id: "brick", name: "Backstein", color: "#c9a876", hatchId: "diag", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "brick", thickness: 0.3 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [wall],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

describe("generatePlan — grob: Wand-Poché immer vollschwarz (SIA 400 Fig. 36)", () => {
  const wallPolys = (plan: ReturnType<typeof generatePlan>, id: string) =>
    plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> => p.kind === "polygon" && p.wallId === id,
    );

  it("grob: Vollschwarz-Füllung auch wenn das Bauteil-Pattern NICHT 'solid' ist (Regression)", () => {
    const plan = generatePlan(nonSolidWallProject(), "eg", new Set(["20"]), undefined, "grob");
    const polys = wallPolys(plan, "W1");
    expect(polys.length).toBeGreaterThan(0);
    expect(polys.every((p) => p.fill === "#0f0f0f")).toBe(true);
    expect(polys.every((p) => p.hatch.pattern === "none")).toBe(true);
  });

  it("mittel/fein: Füllung bleibt bauteilfarben (KEIN Vollschwarz-Zwang) — unverändertes Verhalten", () => {
    for (const detail of ["mittel", "fein"] as const) {
      const plan = generatePlan(nonSolidWallProject(), "eg", new Set(["20"]), undefined, detail);
      const polys = wallPolys(plan, "W1");
      expect(polys.length).toBeGreaterThan(0);
      expect(polys.some((p) => p.fill !== "#0f0f0f")).toBe(true);
    }
  });
});

/** Minimalprojekt mit EINER Decke (Slab) ohne Wände → voller Umriss sichtbar. */
function ceilingProject(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.2 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "30", name: "Decken", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [
      {
        id: "C1",
        type: "ceiling",
        floorId: "eg",
        categoryCode: "30",
        outline: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 2, y: 2 },
          { x: 0, y: 2 },
        ],
        wallTypeId: "aw",
      },
    ],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

describe("generatePlan — Decke = gestrichelte Überkopf-Ansicht", () => {
  it("zeichnet den freien Decken-Umriss gestrichelt (Überkopf-Konvention)", () => {
    const plan = generatePlan(ceilingProject(), "eg", new Set(["30"]), undefined, "mittel");
    const outlines = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "line" }> =>
        p.kind === "line" && p.cls === "ceiling-outline",
    );
    expect(outlines.length).toBeGreaterThan(0);
    // JEDE Decken-Umrisslinie ist gestrichelt (dash gesetzt, nicht null).
    expect(outlines.every((p) => Array.isArray(p.dash) && p.dash.length >= 2)).toBe(true);
  });
});
