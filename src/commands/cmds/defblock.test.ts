/**
 * `defblockCommand` — Mehrfachauswahl + Basispunkt → neue `BlockDef` (lokale
 * Geometrie relativ zum Basispunkt) + eine ersetzende `{shape:"block"}`-
 * Instanz; Quell-Elemente verschwinden aus `drawings2d`.
 */

import { describe, it, expect } from "vitest";
import { defblockCommand } from "./defblock";
import type { CommandContext, Project } from "../types";
import type { Drawing2D } from "../../model/types";

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
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: drawings,
    context: [],
  };
}

function makeCtx(p: Project, drawingIds: string[]): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: drawingIds[0] ?? null, drawingIds },
  };
}

describe("defblockCommand", () => {
  it("erzeugt eine BlockDef aus der Auswahl (lokal relativ zum Basispunkt) + eine ersetzende Instanz", () => {
    const line: Drawing2D = { id: "d1", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: 5, y: 5 }, b: { x: 8, y: 5 } } };
    const circle: Drawing2D = { id: "d2", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "circle", center: { x: 6, y: 6 }, r: 1 } };
    const p = project([line, circle]);
    const ctx = makeCtx(p, ["d1", "d2"]);
    const [, result] = defblockCommand.onInput(
      defblockCommand.init(),
      { kind: "point", point: { x: 5, y: 5 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);

    expect(next.drawings2d.find((d) => d.id === "d1")).toBeUndefined();
    expect(next.drawings2d.find((d) => d.id === "d2")).toBeUndefined();
    expect(next.drawings2d.length).toBe(1);
    const inst = next.drawings2d[0];
    expect(inst.geom.shape).toBe("block");

    expect(next.blockDefs?.length).toBe(1);
    const def = next.blockDefs![0];
    expect(def.name).toBe("Block 1");
    expect(def.geom2d.length).toBe(2);
    const localLine = def.geom2d.find((g) => g.shape === "line");
    if (localLine?.shape === "line") {
      // Basispunkt (5,5) wird zum lokalen Ursprung → a rückt auf (0,0).
      expect(localLine.a).toEqual({ x: 0, y: 0 });
      expect(localLine.b).toEqual({ x: 3, y: 0 });
    }
    if (inst.geom.shape === "block") {
      expect(inst.geom.blockDefId).toBe(def.id);
      expect(inst.geom.at).toEqual({ x: 5, y: 5 });
      expect(inst.geom.rotation).toBe(0);
    }
  });

  it("leere Auswahl committet nichts", () => {
    const p = project([]);
    const ctx = makeCtx(p, []);
    const [, result] = defblockCommand.onInput(
      defblockCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    expect(result.commit).toBeUndefined();
  });

  it("schliesst bereits platzierte Block-Instanzen aus der Auswahl aus (keine verschachtelten Blöcke)", () => {
    const inst: Drawing2D = { id: "b1", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "block", blockDefId: "x", at: { x: 0, y: 0 }, rotation: 0 } };
    const p = project([inst]);
    const ctx = makeCtx(p, ["b1"]);
    const [, result] = defblockCommand.onInput(
      defblockCommand.init(),
      { kind: "point", point: { x: 0, y: 0 } },
      ctx,
    );
    // ids.length > 0 am Eingang (die Auswahl ist nicht leer) → commit ist gesetzt,
    // aber defineAndReplace filtert die Block-Quelle innen raus → No-Op-Ergebnis.
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next.blockDefs ?? []).toEqual([]);
    expect(next.drawings2d.length).toBe(1);
  });
});
