/**
 * Unit-Tests für den materialbewussten T-Stoss im 2D-Plan (generatePlan):
 * an einem T-Stoss zweier verputzter Mauerwerkswände (W9-artig: Innenputz/
 * Backstein-Kern/Innenputz) darf der Abzweig nicht mehr naiv über die volle
 * Dicke an der Durchgangswand-Fläche gekappt werden.
 *  • Der Backstein-Kern des Abzweigs läuft UNGEKAPPT bis zur Durchgangsachse
 *    durch (kein Cut an der Nahfläche) — "durchgehender Kern".
 *  • Die Innenputz-Schichten des Abzweigs enden weiterhin an der Nahfläche
 *    UND bekommen eine zusätzliche seitliche L-Linie (cls "layer-joint-l").
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Project, Wall } from "../model/types";

/** W9-artiger Wandtyp: Innenputz (0.015) / Backstein-Kern (0.12) / Innenputz (0.015). */
function tJunctionProject(): Project {
  const wall = (id: string, start: Wall["start"], end: Wall["end"]): Wall => ({
    id,
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start,
    end,
    wallTypeId: "iw",
    height: 2.6,
  });
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [
      { id: "render-int", name: "Innenputz", color: "#efece6", hatchId: "none", joinPriority: 10 },
      { id: "brick", name: "Backstein", color: "#8c5544", hatchId: "none", joinPriority: 50 },
    ],
    wallTypes: [
      {
        id: "iw",
        name: "Innenwand",
        layers: [
          { componentId: "render-int", thickness: 0.015 },
          { componentId: "brick", thickness: 0.12 },
          { componentId: "render-int", thickness: 0.015 },
        ],
      },
    ],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [
      // Durchgangswand WA1/WA2 in zwei Hälften, Abzweig WB nach oben (5,0)→(5,3).
      wall("WA1", { x: 0, y: 0 }, { x: 5, y: 0 }),
      wall("WA2", { x: 5, y: 0 }, { x: 10, y: 0 }),
      wall("WB", { x: 5, y: 0 }, { x: 5, y: 3 }),
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

describe("generatePlan — materialbewusster T-Stoss (Poché-Bänder)", () => {
  it("lässt den Backstein-Kern des Abzweigs ungekappt durchlaufen, während der Innenputz an der Nahfläche endet", () => {
    const plan = generatePlan(tJunctionProject(), "eg", visible, undefined, "mittel");
    // Die Schicht-Bänder der Wand WB: gefüllte Polygone ohne eigenen Umriss
    // (stroke:"none"), in Schicht-Reihenfolge gepusht (0=Putz,1=Backstein,2=Putz).
    const bands = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> =>
        p.kind === "polygon" && p.wallId === "WB" && p.stroke === "none",
    );
    expect(bands.length).toBe(3);
    const [render0, brick, render2] = bands;

    // clippedBand liefert [edgeStart(offA), edgeEnd(offA), edgeEnd(offB), edgeStart(offB)];
    // edgeStart liegt am Wandanfang (5,0) = der T-Stoss-Seite. Für die beiden
    // Innenputz-Bänder MUSS die Y-Koordinate dort exakt auf der Nahfläche
    // (0.075, halbe Wanddicke 0.15/2) liegen — unverändertes Trim-Verhalten.
    expect(render0.pts[0].y).toBeCloseTo(0.075, 6);
    expect(render0.pts[3].y).toBeCloseTo(0.075, 6);
    expect(render2.pts[0].y).toBeCloseTo(0.075, 6);
    expect(render2.pts[3].y).toBeCloseTo(0.075, 6);

    // Der Backstein-Kern verschmilzt: KEIN Cut an der Nahfläche → die
    // Randpunkte liegen auf der Durchgangsachse (y=0), nicht auf y=0.075.
    expect(brick.pts[0].y).toBeCloseTo(0, 6);
    expect(brick.pts[3].y).toBeCloseTo(0, 6);
  });

  it("zeichnet die L-Seitenlinie nur für die getrimmten Putzschichten, nicht für den durchlaufenden Kern", () => {
    const plan = generatePlan(tJunctionProject(), "eg", visible, undefined, "mittel");
    const lLines = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "line" }> => p.kind === "line" && p.cls === "layer-joint-l",
    );
    // Genau zwei L-Linien (eine je Innenputz-Schicht); der Backstein-Kern
    // bekommt keine (er verschmilzt, kein Sprung im Material).
    expect(lLines.length).toBe(2);

    // Jede L-Linie verläuft entlang der Durchgangsachse (y=0, parallel zur
    // x-Achse) und spannt genau die Breite EINER Putzschicht (0.015 m) auf.
    for (const l of lLines) {
      expect(l.a.y).toBeCloseTo(0, 6);
      expect(l.b.y).toBeCloseTo(0, 6);
      expect(Math.abs(l.a.x - l.b.x)).toBeCloseTo(0.015, 6);
    }
  });

  it("lässt die kollineare Durchgangswand unverändert (keine L-Linien, normale Bänder)", () => {
    const plan = generatePlan(tJunctionProject(), "eg", visible, undefined, "mittel");
    const wa1Bands = plan.primitives.filter(
      (p): p is Extract<typeof p, { kind: "polygon" }> =>
        p.kind === "polygon" && p.wallId === "WA1" && p.stroke === "none",
    );
    expect(wa1Bands.length).toBe(3);
    // Kein Cut an ihrem gemeinsamen Knoten-Ende (endCut bleibt null, s. joins.ts) →
    // alle drei Bänder enden exakt am Achsenpunkt (5,0), keine Gehrung nötig.
    for (const b of wa1Bands) {
      expect(b.pts[1].x).toBeCloseTo(5, 6);
    }
  });
});
