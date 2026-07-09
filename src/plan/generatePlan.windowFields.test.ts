/**
 * Unit-Tests für die NEUEN Fenster-Modellfelder im Grundriss (generatePlan +
 * geometry/opening.windowSymbol):
 *  • `WindowType.sashes` (Flügeltabelle) — ersetzt die gleichmäßige
 *    `wingCount`-Ableitung durch echte Flügel-/Pfostenbreiten, sobald ein
 *    Fenstertyp referenziert ist. Alt-Fall (keine `sashes`/kein `typeId`)
 *    bleibt UNVERÄNDERT (reines `Opening.wingCount`, siehe
 *    generatePlan.openings.test.ts).
 *  • `WindowType.glazingPanes` — steuert die Anzahl paralleler Glaslinien.
 *  • `WindowType.shading` — zeichnet eine zusätzliche, gestrichelte
 *    Kastenkontur über der Öffnung.
 *  • Öffnungsandeutung je Flügel (`SashDef.opening`/`hingeSide`).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Opening, Project, Wall, WindowType } from "../model/types";

/** Minimalprojekt: eine Wand (Dicke 0.3 m, Achse mittig, horizontal entlang x)
 *  + eine Fenster-Öffnung + optionale Fenstertyp-Bibliothek. */
function project(opening: Opening, windowTypes?: WindowType[]): Project {
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
    windowTypes,
    drawingLevels: [
      {
        id: "eg",
        name: "EG",
        kind: "floor",
        visible: true,
        locked: false,
        floorHeight: 2.6,
        cutHeight: 1.0,
        baseElevation: 0,
      },
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

/** Basis-Fenster (Brüstung 0, damit keine Sill-Linie mitzählt), position 1.0, width 1.2. */
const baseWindow: Opening = {
  id: "F1",
  type: "opening",
  hostWallId: "W1",
  categoryCode: "21",
  kind: "window",
  position: 1.0,
  width: 1.2,
  height: 1.2,
  sillHeight: 0,
};

/** Minimaler Fenstertyp (Grunddaten, Felder je Test überschrieben/ergänzt). */
const baseWindowType: WindowType = {
  id: "wt1",
  name: "Test-Fenster",
  kind: "dreh",
  wingCount: 1,
  glazing: "einfach",
  frameThickness: 0.06,
  defaultSillHeight: 0.8,
  defaultWidth: 1.2,
  defaultHeight: 1.2,
};

function linesOfClass(p: Project, cls: string, detail: "grob" | "mittel" | "fein" = "mittel") {
  return generatePlan(p, "eg", visible, undefined, detail).primitives.filter(
    (pr) => pr.kind === "line" && pr.cls === cls,
  );
}

describe("generatePlan — Flügeleinteilung aus sashes (Item 1)", () => {
  it("Alt-Fall (kein typeId/sashes, nur wingCount=3) erzeugt genau 2 Pfostenlinien — Regression", () => {
    const p = project({ ...baseWindow, wingCount: 3 });
    expect(linesOfClass(p, "window-mullion").length).toBe(2);
  });

  it("WindowType MIT sashes (3 feste Flügelbreiten 0.4 m) erzeugt Pfostenlinien exakt an den Flügelgrenzen", () => {
    // Öffnung 1.2 m breit, jambStart bei x=1.0 (position 1.0) -> jambEnd x=2.2.
    // 3 Flügel à 0.4 m (autoWidth:false) -> Grenzen bei x=1.4 und x=1.8.
    const wt: WindowType = {
      ...baseWindowType,
      sashes: [
        { kind: "fluegel", autoWidth: false, width: 0.4, opening: "dreh", hingeSide: "left" },
        { kind: "fluegel", autoWidth: false, width: 0.4, opening: "kipp" },
        { kind: "fluegel", autoWidth: false, width: 0.4, opening: "dreh", hingeSide: "right" },
      ],
    };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    const mullions = linesOfClass(p, "window-mullion");
    expect(mullions.length).toBe(2);
    const xs = mullions
      .map((pr) => (pr.kind === "line" ? pr.a.x : NaN))
      .sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(1.4, 6);
    expect(xs[1]).toBeCloseTo(1.8, 6);
  });

  it("WindowType MIT sashes, aber alle autoWidth (kein fixes width/pfosten) -> identische Grenzen wie die alte wingCount-Gleichverteilung", () => {
    // 3 gleichmässige Flügel über sashesOfWindowType (kein `sashes` am Typ,
    // nur `wingCount: 3`) müssen exakt dieselben Pfosten liefern wie der
    // Alt-Fall ohne Typ (Regressionssicherheit der Ableitung).
    const wt: WindowType = { ...baseWindowType, wingCount: 3 };
    const withType = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    const withoutType = project({ ...baseWindow, wingCount: 3 });
    const linesOf = (p: Project) =>
      linesOfClass(p, "window-mullion")
        .map((pr) => (pr.kind === "line" ? pr.a.x : NaN))
        .sort((a, b) => a - b);
    const a = linesOf(withType);
    const b = linesOf(withoutType);
    expect(a.length).toBe(b.length);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
  });

  it("Flügel mit opening !== 'fest' erzeugt eine Öffnungsandeutung (window-opening); 'fest' keine", () => {
    const wt: WindowType = {
      ...baseWindowType,
      sashes: [
        { kind: "fluegel", autoWidth: true, opening: "dreh", hingeSide: "left" },
        { kind: "fluegel", autoWidth: true, opening: "fest" },
      ],
    };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(linesOfClass(p, "window-opening").length).toBe(1);
  });

  it("Alt-Fall (kein typeId) erzeugt KEINE Öffnungsandeutung", () => {
    const p = project({ ...baseWindow });
    expect(linesOfClass(p, "window-opening").length).toBe(0);
  });
});

describe("generatePlan — Verglasung glazingPanes (Item 2)", () => {
  const glassLineCount = (p: Project, detail: "grob" | "mittel" | "fein" = "mittel") =>
    linesOfClass(p, "window-glass", detail).length;

  it("glazingPanes: 3 erzeugt mehr Glaslinien als glazingPanes: 1", () => {
    const wt3: WindowType = { ...baseWindowType, id: "wt3", glazingPanes: 3 };
    const wt1: WindowType = { ...baseWindowType, id: "wt1", glazingPanes: 1 };
    const p3 = project({ ...baseWindow, typeId: "wt3" }, [wt3]);
    const p1 = project({ ...baseWindow, typeId: "wt1" }, [wt1]);
    expect(glassLineCount(p3)).toBeGreaterThan(glassLineCount(p1));
    expect(glassLineCount(p3)).toBe(3);
    expect(glassLineCount(p1)).toBe(1);
  });

  it("ohne typeId bleibt die alte Detailgrad-Regel (grob/mittel=1, fein=2) unverändert — Regression", () => {
    const p = project({ ...baseWindow });
    expect(glassLineCount(p, "grob")).toBe(1);
    expect(glassLineCount(p, "mittel")).toBe(1);
    expect(glassLineCount(p, "fein")).toBe(2);
  });

  it("glazingPanes wirkt bei 'grob' NICHT (bleibt bei 1 Glaslinie)", () => {
    const wt: WindowType = { ...baseWindowType, glazingPanes: 3 };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(glassLineCount(p, "grob")).toBe(1);
  });
});

describe("generatePlan — Rollladenkasten shading (Item 3)", () => {
  const shadingLineCount = (p: Project) => linesOfClass(p, "window-shading").length;

  it("shading.create: true erzeugt eine zusätzliche Kastenkontur (4 Linien)", () => {
    const wt: WindowType = {
      ...baseWindowType,
      shading: { create: true, kind: "rollladen", box: { width: 1.2, height: 0.2, depth: 0.15 } },
    };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(shadingLineCount(p)).toBe(4);
  });

  it("shading.create: false erzeugt KEINE Kastenkontur", () => {
    const wt: WindowType = {
      ...baseWindowType,
      shading: { create: false, kind: "rollladen", box: { width: 1.2, height: 0.2, depth: 0.15 } },
    };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(shadingLineCount(p)).toBe(0);
  });

  it("kein shading-Feld am Typ erzeugt KEINE Kastenkontur", () => {
    const p = project({ ...baseWindow, typeId: "wt1" }, [baseWindowType]);
    expect(shadingLineCount(p)).toBe(0);
  });

  it("ohne typeId (Alt-Fall) erzeugt KEINE Kastenkontur", () => {
    const p = project({ ...baseWindow });
    expect(shadingLineCount(p)).toBe(0);
  });
});
