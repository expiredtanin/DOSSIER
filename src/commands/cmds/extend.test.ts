/**
 * `extendCommand` — Gegenstück zu Trim (`extendSegment` im Kernel existierte
 * bereits, hatte aber keinen Aufrufer). Test: eine kurze Linie wird bis zu
 * einer kreuzenden Cutter-Linie verlängert.
 */

import { describe, it, expect } from "vitest";
import { extendCommand } from "./extend";
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
    drawings2d: [
      // Cutter: vertikale Linie bei x=5, deckt y=-10..10 ab.
      { id: "cutter", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: 5, y: -10 }, b: { x: 5, y: 10 } } },
      // Ziel: kurze horizontale Linie von (0,0) bis (3,0) — reicht nicht bis zum Cutter.
      { id: "target", type: "drawing2d", levelId: "eg", categoryCode: "20", geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 3, y: 0 } } },
    ],
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

describe("extendCommand", () => {
  it("verlängert das nähere Ende der Linie bis zum nächsten Cutter", () => {
    const p = project();
    const ctx = makeCtx(p);
    const [, result] = extendCommand.onInput(
      extendCommand.init(),
      { kind: "point", point: { x: 3, y: 0 } }, // nahe am Ende (3,0) der Ziellinie
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    const target = next.drawings2d.find((d) => d.id === "target")!;
    expect(target.geom.shape).toBe("line");
    if (target.geom.shape === "line") {
      expect(target.geom.a).toEqual({ x: 0, y: 0 }); // unverändertes Ende bleibt stehen
      expect(target.geom.b.x).toBeCloseTo(5, 9); // bis zum Cutter (x=5) verlängert
      expect(target.geom.b.y).toBeCloseTo(0, 9);
    }
  });

  it("kein Cutter getroffen → No-op (kein commit-Effekt)", () => {
    const p = project();
    // Cutter entfernen: nichts zum Verlängern-bis da.
    p.drawings2d = p.drawings2d.filter((d) => d.id !== "cutter");
    const ctx = makeCtx(p);
    const [, result] = extendCommand.onInput(
      extendCommand.init(),
      { kind: "point", point: { x: 3, y: 0 } },
      ctx,
    );
    expect(result.commit).toBeDefined();
    const next = result.commit!(p);
    expect(next).toBe(p); // unverändert (No-op)
  });
});
