// Freitext-Formatierung (Text-Werkzeug + Oberleisten-Formatier-Gruppe): die
// einheitlichen Marks (Schriftfamilie/fett/kursiv/Farbe) eines Drawing2D-Texts
// müssen ins `drawingText`-Primitiv wandern; marks.color hat Vorrang vor der
// Kategorie-/Elementfarbe.

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Drawing2D, Project } from "../model/types";
import type { Marks } from "../text/richText";

/** Baut ein Text-Drawing mit optionalen Marks (umgeht die Union-Verengung). */
function textDrawing(marks?: Marks): Drawing2D {
  return {
    id: "TX1",
    type: "drawing2d",
    levelId: "eg",
    categoryCode: "70",
    geom: { shape: "text", at: { x: 1, y: 1 }, text: "Hallo", height: 0.2, angle: 0, ...(marks ? { marks } : {}) },
  };
}

function projectWithText(drawing: Drawing2D): Project {
  return {
    id: "p",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [],
    wallTypes: [],
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
      { code: "70", name: "Text", color: "#0a0a0a", lw: 0.3, visible: true, locked: false },
    ],
    walls: [],
    doors: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [drawing],
    context: [],
  } as unknown as Project;
}

const visible = new Set(["70"]);

function textPrim(drawing: Drawing2D) {
  return generatePlan(projectWithText(drawing), "eg", visible, undefined, "mittel")
    .primitives.find((p) => p.kind === "drawingText");
}

describe("Drawing2D-Text: Marks im drawingText-Primitiv", () => {
  it("trägt marks (font/bold/italic) ins Primitiv", () => {
    const p = textPrim(textDrawing({ font: "Merriweather", bold: true, italic: true })) as
      | { marks?: { font?: string; bold?: boolean; italic?: boolean } }
      | undefined;
    expect(p?.marks?.font).toBe("Merriweather");
    expect(p?.marks?.bold).toBe(true);
    expect(p?.marks?.italic).toBe(true);
  });

  it("marks.color übersteuert die Kategorie-Farbe", () => {
    const p = textPrim(textDrawing({ color: "#ff0000" })) as { color: string } | undefined;
    expect(p?.color).toBe("#ff0000");
  });

  it("ohne marks bleibt das Primitiv unverändert (kein marks-Feld)", () => {
    const p = textPrim(textDrawing()) as { marks?: unknown } | undefined;
    expect(p).toBeTruthy();
    expect(p?.marks).toBeUndefined();
  });
});
