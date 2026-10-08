/**
 * Schraffur-Platzierung am Objekt: Ankerpunkt des Musterrasters.
 * Kernzusage — ohne Anker hängt die Musterphase am MODELLURSPRUNG (damit
 * benachbarte Flächen zusammenpassen), mit Anker am gewählten Punkt.
 */

import { describe, expect, it } from "vitest";
import { hatchLineFamily } from "./glPlanHatch";
import type { Vec2 } from "../../model/types";

/** Quadrat 4×4, dessen linke untere Ecke NICHT im Ursprung liegt. */
const POLY: Vec2[] = [
  { x: 1.3, y: 0.7 },
  { x: 5.3, y: 0.7 },
  { x: 5.3, y: 4.7 },
  { x: 1.3, y: 4.7 },
];

describe("hatchLineFamily — Ankerpunkt", () => {
  it("ohne Anker liegt das Raster auf ganzzahligen Vielfachen ab dem Modellursprung", () => {
    for (const y of hatchLineFamily(POLY, 0, 1, 0).map((s) => s.a.y)) {
      expect(Math.abs(y - Math.round(y))).toBeLessThan(1e-9);
    }
  });

  it("mit Anker beginnt das Raster GENAU dort (Ecke statt Weltnullpunkt)", () => {
    const anchor = { x: 1.3, y: 0.7 };
    const ys = hatchLineFamily(POLY, 0, 1, 0, anchor).map((s) => s.a.y);
    // Jede Linie liegt auf anchor.y + k·Abstand.
    for (const y of ys) {
      const k = (y - anchor.y) / 1;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    }
    // Und der Anker selbst ist eine der Linien (Phase 0).
    expect(ys.some((y) => Math.abs(y - anchor.y) < 1e-9)).toBe(true);
  });

  it("ein verschobener Anker verschiebt die Phase entsprechend", () => {
    // Aussagekräftig ist die PHASE (Lage modulo Abstand), nicht die erste
    // erzeugte Linie: je nach Anker beginnt das Raster einen ganzen Schritt
    // früher oder später, ohne dass sich am Muster etwas ändert.
    const phase = (anchorY: number) => {
      const y = hatchLineFamily(POLY, 0, 1, 0, { x: 0, y: anchorY })[0].a.y;
      return ((y % 1) + 1) % 1;
    };
    expect(phase(0.25)).toBeCloseTo(0.25, 9);
    expect(phase(0.75)).toBeCloseTo(0.75, 9);
    // Ein Anker um genau einen Abstand versetzt ergibt dieselbe Phase.
    expect(phase(0.25)).toBeCloseTo(phase(1.25), 9);
  });

  it("der Anker ändert NUR die Phase, nicht den Abstand", () => {
    const spacing = (anchor?: Vec2) => {
      const ys = hatchLineFamily(POLY, 0, 1, 0, anchor).map((s) => s.a.y).sort((x, y) => x - y);
      return ys[1] - ys[0];
    };
    expect(spacing()).toBeCloseTo(spacing({ x: 2.2, y: 3.3 }), 9);
  });
});
