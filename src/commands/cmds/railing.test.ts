/**
 * [279] Befehl „gelaender": Polylinie auf dem aktiven Geschoss, Enter beendet (offen), „Schliessen" und Klick auf den
 * Startpunkt schliessen den Zug; Zahl = Höhe, Option = Art; die Ops baut der Kern (Ebene 41, Vorgaben).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { railingCommand, railingDefaults } from "./railing";
import type { CommandContext, Project } from "../types";

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers: [
      { code: "41", name: "Geländer", color: "#0a0a0a", lw: 0.18, visible: true, locked: false },
      { code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
    ],
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
  return { project: p, level: p.drawingLevels[0], defaultCategoryCode: "20", activeLineStyleId: "solid", activeWallTypeId: "aw", lastPoint: null, selection: { wallIds: [], drawingId: null } };
}

describe("railingCommand (gelaender)", () => {
  beforeEach(() => {
    Object.assign(railingDefaults, { kind: "bars", height: 1.0 });
  });

  it("Punkte, Enter: offenes Geländer auf Ebene 41 mit Vorgaben (Höhe 1.00 m, Stäbe)", () => {
    const p = project();
    const ctx = makeCtx(p);
    let st = railingCommand.init();
    [st] = railingCommand.onInput(st, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [st] = railingCommand.onInput(st, { kind: "point", point: { x: 3, y: 0 } }, ctx);
    [st] = railingCommand.onInput(st, { kind: "point", point: { x: 3, y: 2 } }, ctx);
    // Vorschau: Zug samt Gummiband.
    const [, mv] = railingCommand.onMove!(st, { x: 5, y: 2 }, null, ctx);
    expect(mv.draft?.preview?.length).toBeGreaterThan(0);
    const [, r] = railingCommand.onConfirm!(st, ctx);
    expect(r.done).toBe(true);
    const next = r.commit!(p);
    expect(next.railings?.length).toBe(1);
    expect(next.railings![0]).toMatchObject({
      type: "railing",
      floorId: "eg",
      categoryCode: "41",
      kind: "bars",
      height: 1,
      points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }],
    });
    expect(next.railings![0].closed).toBeUndefined();
  });

  it("Zahl = Höhe, Option wechselt die Art; Schliessen ab drei Punkten, Klick auf den Start schliesst auch", () => {
    const p = project();
    const ctx = makeCtx(p);
    let st = railingCommand.init();
    [st] = railingCommand.onInput(st, { kind: "number", value: 1.1 }, ctx);
    [st] = railingCommand.onInput(st, { kind: "option", id: "kind" }, ctx);
    expect(railingDefaults).toMatchObject({ kind: "glass", height: 1.1 });
    for (const q of [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }]) [st] = railingCommand.onInput(st, { kind: "point", point: q }, ctx);
    expect(railingCommand.options(st).map((o) => o.id)).toContain("close");
    const [, r] = railingCommand.onInput(st, { kind: "option", id: "close" }, ctx);
    expect(r.done).toBe(true);
    expect(r.commit!(p).railings![0]).toMatchObject({ kind: "glass", height: 1.1, closed: true });
    // Klick nahe am Startpunkt schliesst ebenfalls.
    const [, r2] = railingCommand.onInput(st, { kind: "point", point: { x: 0.02, y: 0.01 } }, ctx);
    expect(r2.commit!(p).railings![0].closed).toBe(true);
    // Unsinn: Höhe 0 oder riesig wird nicht übernommen; ein einzelner Punkt gibt kein Geländer.
    [st] = railingCommand.onInput(railingCommand.init(), { kind: "number", value: 0 }, ctx);
    [st] = railingCommand.onInput(st, { kind: "number", value: 99 }, ctx);
    expect(railingDefaults.height).toBe(1.1);
    [st] = railingCommand.onInput(st, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    expect(railingCommand.onConfirm!(st, ctx)[1].commit).toBeUndefined();
  });

  it("Zurück nimmt den letzten Punkt weg; ein Klick auf denselben Punkt zählt nicht", () => {
    const ctx = makeCtx(project());
    let st = railingCommand.init();
    [st] = railingCommand.onInput(st, { kind: "point", point: { x: 0, y: 0 } }, ctx);
    [st] = railingCommand.onInput(st, { kind: "point", point: { x: 1, y: 0 } }, ctx);
    [st] = railingCommand.onInput(st, { kind: "point", point: { x: 1, y: 0 } }, ctx);
    [st] = railingCommand.onInput(st, { kind: "option", id: "undo" }, ctx);
    const [, r] = railingCommand.onConfirm!(st, ctx);
    expect(r.commit).toBeUndefined();
  });
});
