/**
 * `textboxCommand` — committet seit der Umstellung auf Inline-Editing (kein
 * Dialog/keine Befehlszeilen-Eingabe mehr, InDesign-artiges Textrahmen-
 * Verhalten, Nutzer-Wunsch) SOFORT ein leeres Text-Element MIT Spaltenbreite
 * nach Anker+Breite und meldet `focusDrawingId`.
 */

import { describe, it, expect } from "vitest";
import { textboxCommand } from "./textbox";
import type { CommandContext, Project } from "../types";

function project(): Project {
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
    drawings2d: [],
    context: [],
  };
}

function makeCtx(p: Project): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null },
  };
}

describe("textboxCommand", () => {
  it("committet nach Anker+Breite sofort ein leeres Text-Element mit width und meldet focusDrawingId", () => {
    const p = project();
    const ctx = makeCtx(p);

    const [afterPoint] = textboxCommand.onInput(
      textboxCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    const [, result] = textboxCommand.onInput(
      afterPoint,
      { kind: "point", point: { x: 2, y: 0 } }, // Spaltenbreite = 2m
      ctx,
    );
    expect(result.done).toBe(true);
    expect(result.commit).toBeDefined();
    expect(result.focusDrawingId).toBeDefined();

    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const d = next.drawings2d[0];
    expect(d.id).toBe(result.focusDrawingId);
    expect(d.geom.shape).toBe("text");
    if (d.geom.shape === "text") {
      expect(d.geom.text).toBe("");
      expect(d.geom.width).toBeCloseTo(2, 9); // InDesign-artiger Textrahmen: Breite gesetzt
    }
  });
});
