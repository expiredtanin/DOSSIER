/**
 * Unit-Tests für das Cursor-HUD (Länge/Winkel) des `wall`-Befehls: nach dem
 * Startpunkt muss `onMove` im Draft `hud.length`/`hud.angleDeg` relativ zum
 * ZULETZT gesetzten Achspunkt liefern — auch nach mehreren Segmenten
 * (Chaining), damit ein mehrteiliger Wandzug je Segment ein frisches HUD zeigt.
 */

import { describe, it, expect } from "vitest";
import { wallCommand } from "./wall";
import type { CommandContext, Project, Vec2 } from "../types";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [
      { id: "aw", name: "AW", layers: [{ componentId: "c", thickness: 0.2 }] },
    ],
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
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
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

describe("wallCommand — Cursor-HUD (Länge/Winkel)", () => {
  it("liefert hud.length/angleDeg relativ zum Startpunkt", () => {
    const start: Vec2 = { x: 0, y: 0 };
    const [afterStart] = wallCommand.onInput(
      wallCommand.init(),
      { kind: "point", point: start },
      makeCtx(null),
    );
    const [, res] = wallCommand.onMove(afterStart, { x: 4, y: 0 }, null, makeCtx(start));
    expect(res.draft?.hud?.length).toBeCloseTo(4, 9);
    expect(res.draft?.hud?.angleDeg).toBeCloseTo(0, 9);
  });

  it("HUD bezieht sich nach dem zweiten Punkt auf das NEUE (letzte) Segment", () => {
    const p0: Vec2 = { x: 0, y: 0 };
    const p1: Vec2 = { x: 4, y: 0 };
    const [s1] = wallCommand.onInput(wallCommand.init(), { kind: "point", point: p0 }, makeCtx(null));
    const [s2] = wallCommand.onInput(s1, { kind: "point", point: p1 }, makeCtx(p0));
    // Nächstes Segment ab p1 nach oben (0,3) → Länge 3, Winkel 90°.
    const [, res] = wallCommand.onMove(s2, { x: 4, y: 3 }, null, makeCtx(p1));
    expect(res.draft?.hud?.length).toBeCloseTo(3, 9);
    expect(res.draft?.hud?.angleDeg).toBeCloseTo(90, 9);
  });

  it("zeigt KEIN HUD vor dem Startpunkt (phase=start)", () => {
    const [, res] = wallCommand.onMove(wallCommand.init(), { x: 1, y: 1 }, null, makeCtx(null));
    expect(res.draft).toBeNull();
  });
});
