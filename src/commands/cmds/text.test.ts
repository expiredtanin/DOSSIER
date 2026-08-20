/**
 * `textCommand` — committet seit der Umstellung auf Inline-Editing (kein
 * Dialog/keine Befehlszeilen-Eingabe mehr, Nutzer-Wunsch) SOFORT ein leeres
 * Text-Element nach dem Ankerpunkt und meldet `focusDrawingId`, damit die UI
 * (PlanView) direkt den Inline-Rich-Text-Editor öffnet.
 */

import { describe, it, expect } from "vitest";
import { textCommand } from "./text";
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

describe("textCommand", () => {
  it("committet sofort ein leeres Text-Element und meldet focusDrawingId", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [, result] = textCommand.onInput(
      textCommand.init(),
      { kind: "point", point: { x: 3, y: 4 } },
      ctx,
    );
    expect(result.done).toBe(true);
    expect(result.commit).toBeDefined();
    expect(result.focusDrawingId).toBeDefined();

    const next = result.commit!(p);
    expect(next.drawings2d.length).toBe(1);
    const d = next.drawings2d[0];
    expect(d.id).toBe(result.focusDrawingId); // dieselbe ID wie im Commit erzeugt
    expect(d.geom.shape).toBe("text");
    if (d.geom.shape === "text") {
      expect(d.geom.text).toBe("");
      expect(d.geom.at).toEqual({ x: 3, y: 4 });
      expect(d.geom.width).toBeUndefined(); // Text-Werkzeug: KEIN Wortumbruch
    }
  });
});
