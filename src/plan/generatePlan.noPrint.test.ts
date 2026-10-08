// `Drawing2D.noPrint` (Nutzer-Wunsch: „Kein 'nicht druckend'-Flag im Modell —
// selbst `xline` druckt mit") — ein als `noPrint` markiertes Element bleibt
// am Bildschirm normal sichtbar, fehlt aber im Export (`generatePlan(...,
// forPrint: true)`, s. `state/useExportHandlers.ts`).

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Drawing2D, Project } from "../model/types";

function lineDrawing(id: string, noPrint?: boolean): Drawing2D {
  return {
    id,
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "20",
    geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
    ...(noPrint !== undefined ? { noPrint } : {}),
  };
}

function project(drawings: Drawing2D[]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: drawings,
    context: [],
  } as unknown as Project;
}

const visible = new Set(["20"]);

// generatePlan-Positionsparameter bis `forPrint` (10.): project, floorId,
// visibleCodes, categoryDisplay, detail, showReferenceLines, mono,
// includeGlobal, scaleDenominator, forPrint.
function linePrimCount(p: Project, forPrint: boolean) {
  return generatePlan(p, "eg", visible, undefined, "mittel", false, false, true, undefined, forPrint)
    .primitives.filter((pr) => pr.kind === "line" && pr.drawingId).length;
}

describe("generatePlan — Drawing2D.noPrint", () => {
  it("Default (forPrint=false, Bildschirm): ein noPrint-Element bleibt sichtbar", () => {
    const p = project([lineDrawing("d1", true)]);
    expect(linePrimCount(p, false)).toBe(1);
  });

  it("forPrint=true (Export): ein noPrint-Element fehlt", () => {
    const p = project([lineDrawing("d1", true)]);
    expect(linePrimCount(p, true)).toBe(0);
  });

  it("forPrint=true lässt normale (nicht-noPrint) Elemente unangetastet", () => {
    const p = project([lineDrawing("d1", false), lineDrawing("d2")]); // d2: Feld fehlt ganz (Alt-Daten)
    expect(linePrimCount(p, true)).toBe(2);
  });

  it("gemischte Auswahl: forPrint=true lässt nur die noPrint-Elemente weg", () => {
    const p = project([lineDrawing("d1", true), lineDrawing("d2", false)]);
    expect(linePrimCount(p, true)).toBe(1);
    expect(linePrimCount(p, false)).toBe(2);
  });
});
