/**
 * [149] Werkzeug „Baum": Klick setzt einen Baum (Ebene 13, Vorgaben, Optionen), Zahl = Kronendurchmesser,
 * mehrere Bäume nacheinander; „Kreise in Bäume umwandeln" ersetzt die Kreise der Baum-Ebene.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { circlesToTreesCommand, treeCommand, treeDefaults } from "./tree";
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
    layers: [
      { code: "13", name: "Bäume", color: "#0a0a0a", lw: 0.13, visible: true, locked: false },
      { code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
    ],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [
      { id: "k1", type: "drawing2d", levelId: "eg", categoryCode: "13", geom: { shape: "circle", center: { x: 3, y: 4 }, r: 2.5 } },
      { id: "k2", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "circle", center: { x: 0, y: 0 }, r: 1 } },
    ],
    context: [],
  };
}

function makeCtx(p: Project, drawingIds: string[] = []): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null, drawingIds },
  };
}

describe("treeCommand", () => {
  beforeEach(() => {
    Object.assign(treeDefaults, { shape: "round", status: "existing", foliage: "deciduous", crownDiameter: 5, height: 10 });
  });

  it("Klick setzt einen Baum auf der Baum-Ebene; der Befehl bleibt für den nächsten", () => {
    const p = project();
    const ctx = makeCtx(p);
    let st = treeCommand.init();
    // Zahl = Kronendurchmesser, Optionen wechseln Bestand und Laub/Nadel (Nadel → Kegel).
    [st] = treeCommand.onInput(st, { kind: "number", value: 7 }, ctx);
    [st] = treeCommand.onInput(st, { kind: "option", id: "status" }, ctx);
    [st] = treeCommand.onInput(st, { kind: "option", id: "foliage" }, ctx);
    const [st2, r] = treeCommand.onInput(st, { kind: "point", point: { x: 4, y: 2 } }, ctx);
    expect(r.done).toBeFalsy();
    expect(r.commit).toBeDefined();
    const next = r.commit!(p);
    expect(next.trees?.length).toBe(1);
    const t = next.trees![0];
    expect(t).toMatchObject({
      type: "tree",
      floorId: "eg",
      categoryCode: "13",
      position: { x: 4, y: 2 },
      crownDiameter: 7,
      height: 10,
      status: "new",
      foliage: "conifer",
      shape: "conical",
    });
    // Zweiter Klick: zweiter Baum mit eigener id.
    const [, r2] = treeCommand.onInput(st2, { kind: "point", point: { x: 10, y: 2 } }, makeCtx(next));
    const n2 = r2.commit!(next);
    expect(n2.trees?.length).toBe(2);
    expect(n2.trees![1].id).not.toBe(t.id);
    // Vorschau: Kronenkreis am Cursor.
    const [, mv] = treeCommand.onMove!(st2, { x: 1, y: 1 }, null, ctx);
    expect(mv.draft?.preview?.length).toBeGreaterThan(0);
  });

  it("Kreise in Bäume umwandeln: nur Kreise der Baum-Ebene, Kreise entfallen", () => {
    const p = project();
    const r = circlesToTreesCommand.autoRun!(makeCtx(p));
    const next = r.commit!(p);
    expect(next.drawings2d.map((d) => d.id)).toEqual(["k2"]);
    expect(next.trees?.length).toBe(1);
    expect(next.trees![0]).toMatchObject({ position: { x: 3, y: 4 }, crownDiameter: 5, categoryCode: "13" });
    // Mit Auswahl: genau die gewählten Kreise.
    const n2 = circlesToTreesCommand.autoRun!(makeCtx(p, ["k2"])).commit!(p);
    expect(n2.drawings2d.map((d) => d.id)).toEqual(["k1"]);
    expect(n2.trees![0].crownDiameter).toBe(2);
  });
});
