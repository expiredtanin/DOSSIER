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

describe("lineCommand — durchgehendes Verketten", () => {
  it("committet JEDES Segment einzeln, der Befehl bleibt zwischendurch aktiv (kein done)", () => {
    const p = project();
    const ctx = makeCtx(null);
    let state = lineCommand.init();
    [state] = lineCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [afterSeg1, res1] = lineCommand.onInput(state, { kind: "point", point: { x: 3, y: 0 } }, ctx);
    expect(res1.done).toBeFalsy();
    expect(res1.commit).toBeDefined();
    let next = res1.commit!(p);
    expect(next.drawings2d.length).toBe(1);

    // Zweites Segment startet dort, wo das erste endete (3,0) — kein neuer Klick auf den Start nötig.
    const [, res2] = lineCommand.onInput(afterSeg1, { kind: "point", point: { x: 3, y: 5 } }, ctx);
    expect(res2.done).toBeFalsy();
    next = res2.commit!(next);
    expect(next.drawings2d.length).toBe(2);
    const g1 = next.drawings2d[0].geom;
    const g2 = next.drawings2d[1].geom;
    expect(g1.shape).toBe("line");
    expect(g2.shape).toBe("line");
    if (g1.shape === "line" && g2.shape === "line") {
      expect(g1.a).toEqual({ x: 0, y: 0 });
      expect(g1.b).toEqual({ x: 3, y: 0 });
      // Zweites Segment knüpft am Endpunkt des ersten an.
      expect(g2.a).toEqual({ x: 3, y: 0 });
      expect(g2.b).toEqual({ x: 3, y: 5 });
    }
  });

  it("Klick auf denselben Punkt (Nulllänge) wird ignoriert, Kette bleibt aktiv", () => {
    const ctx = makeCtx(null);
    let state = lineCommand.init();
    [state] = lineCommand.onInput(state, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    const [after, res] = lineCommand.onInput(state, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    expect(res.commit).toBeUndefined();
    expect(res.done).toBeFalsy();
    expect((after as { phase: string }).phase).toBe("end");
  });

  it("Enter (onConfirm) beendet die Kette ohne abschliessendes Segment zum Cursor", () => {
    const ctx = makeCtx(null);
    let state = lineCommand.init();
    [state] = lineCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [state] = lineCommand.onInput(state, { kind: "point", point: { x: 3, y: 0 } }, ctx);
    const [after, res] = lineCommand.onConfirm(state, ctx);
    expect(res.done).toBe(true);
    expect(res.commit).toBeUndefined();
    expect((after as { phase: string }).phase).toBe("start");
  });

  it("Escape (onCancel) beendet die Kette ebenso", () => {
    const ctx = makeCtx(null);
    let state = lineCommand.init();
    [state] = lineCommand.onInput(state, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    const [after, res] = lineCommand.onCancel(state);
    expect(res.done).toBe(true);
    expect((after as { phase: string }).phase).toBe("start");
  });
});
