/**
 * `textboxCommand` — committet seit der Umstellung auf Inline-Editing (kein
 * Dialog/keine Befehlszeilen-Eingabe mehr, InDesign-artiges Textrahmen-
 * Verhalten, Nutzer-Wunsch) SOFORT ein leeres Text-Element MIT Spaltenbreite
 * nach einem aufgezogenen RECHTECK (zwei diagonale Ecken, nicht nur eine
 * Breitenlinie) und meldet `focusDrawingId` + `focusMinHeightM` (die
 * aufgezogene Rahmenhöhe als Mindesthöhe des Inline-Editors).
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
  it("committet nach einem Rechteck (2 Ecken) ein leeres Text-Element mit width + meldet focusDrawingId/focusMinHeightM", () => {
    const p = project();
    const ctx = makeCtx(p);

    const [afterFirst] = textboxCommand.onInput(
      textboxCommand.init(),
      { kind: "point", point: { x: 0, y: 5 } },
      ctx,
    );
    // Gegenecke: 3m breit, 1.5m hoch (Rahmen, keine reine Breitenlinie mehr).
    const [, result] = textboxCommand.onInput(
      afterFirst,
      { kind: "point", point: { x: 3, y: 3.5 } },
      ctx,
    );
    expect(result.done).toBe(true);
    expect(result.commit).toBeDefined();
    expect(result.focusDrawingId).toBeDefined();
    expect(result.focusMinHeightM).toBeCloseTo(1.5, 9);

    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const d = next.drawings2d[0];
    expect(d.id).toBe(result.focusDrawingId);
    expect(d.geom.shape).toBe("text");
    if (d.geom.shape === "text") {
      expect(d.geom.text).toBe("");
      expect(d.geom.width).toBeCloseTo(3, 9); // InDesign-artiger Textrahmen: Breite gesetzt
      expect(d.geom.at.x).toBeCloseTo(0, 9); // oben-links des Rahmens (unabhängig von der Zugrichtung)
    }
  });

  it("beliebige Zugrichtung (Gegenecke oben-links vom Start): Rahmen wird trotzdem korrekt normalisiert", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [afterFirst] = textboxCommand.onInput(
      textboxCommand.init(),
      { kind: "point", point: { x: 5, y: 2 } },
      ctx,
    );
    const [, result] = textboxCommand.onInput(
      afterFirst,
      { kind: "point", point: { x: 2, y: 4 } }, // Gegenecke LINKS und OBEN vom Start
      ctx,
    );
    const next = result.commit!(p);
    const d = next.drawings2d[0];
    if (d.geom.shape === "text") {
      expect(d.geom.width).toBeCloseTo(3, 9); // |5-2|
      expect(d.geom.at.x).toBeCloseTo(2, 9); // min(x)
    }
    expect(result.focusMinHeightM).toBeCloseTo(2, 9); // |4-2|
  });
});
