/**
 * Unit-Tests für das Cursor-HUD (Länge/Winkel) des `line`-Befehls: nach dem
 * Startpunkt muss `onMove` im Draft `hud.length`/`hud.angleDeg` mit den
 * korrekten Werten liefern (VW-Stil L/W-Kästchen, PlanView rendert es).
 */

import { describe, it, expect } from "vitest";
import { lineCommand } from "./line";
import type { CommandContext, Project, Vec2 } from "../types";

/** Minimalprojekt — nur die Felder, die der Befehl/Context anfassen. */
function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
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

function makeCtx(lastPoint: Vec2 | null): CommandContext {
  const p = project();
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint,
    selection: { wallIds: [], drawingId: null },
  };
}

describe("lineCommand — Cursor-HUD (Länge/Winkel)", () => {
  it("liefert hud.length/angleDeg im onMove nach dem Startpunkt", () => {
    const start: Vec2 = { x: 0, y: 0 };
    const [afterStart] = lineCommand.onInput(
      lineCommand.init(),
      { kind: "point", point: start },
      makeCtx(null),
    );
    const [, res] = lineCommand.onMove(afterStart, { x: 3, y: 4 }, null, makeCtx(start));
    expect(res.draft?.hud?.length).toBeCloseTo(5, 9);
    expect(res.draft?.hud?.angleDeg).toBeCloseTo((Math.atan2(4, 3) * 180) / Math.PI, 9);
  });

  it("liefert einen negativen Winkel (Bereich (−180,180]) für Segmente nach unten-links", () => {
    const start: Vec2 = { x: 0, y: 0 };
    const [afterStart] = lineCommand.onInput(
      lineCommand.init(),
      { kind: "point", point: start },
      makeCtx(null),
    );
    // Richtung (-1,-1) → -135° (wie im VW-Screenshot).
    const [, res] = lineCommand.onMove(afterStart, { x: -2, y: -2 }, null, makeCtx(start));
    expect(res.draft?.hud?.angleDeg).toBeCloseTo(-135, 9);
    expect(res.draft?.hud?.length).toBeCloseTo(Math.hypot(2, 2), 9);
  });

  it("zeigt KEIN HUD vor dem Startpunkt (phase=start)", () => {
    const [, res] = lineCommand.onMove(lineCommand.init(), { x: 1, y: 1 }, null, makeCtx(null));
    expect(res.draft).toBeNull();
  });
});
