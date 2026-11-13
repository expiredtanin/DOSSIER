/**
 * [222] „Körper in Bauteile umwandeln": gewählter Körper → Aussenwände je Geschoss, Decken, Flachdach (ein Commit),
 * fehlende Geschosse obenauf; Unsinn (verjüngt, UK zwischen Geschossen) mit Meldung abgelehnt; ohne Auswahl Klick.
 */

import { describe, it, expect } from "vitest";
import { solidToPartsCommand } from "./solidToParts";
import { resolveCommand } from "../registry";
import type { CommandContext, Project } from "../types";
import type { ExtrudedSolid } from "../../model/types";

/** L-förmiger Körper (konkav) 10 × 8 m, Höhe `h`, auf dem EG. */
const solid = (h: number, extra: Partial<ExtrudedSolid> = {}): ExtrudedSolid => ({
  id: "K",
  type: "extrudedSolid",
  levelId: "eg",
  categoryCode: "90",
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 8 }, { x: 0, y: 8 }],
  height: h,
  ...extra,
});

function project(s: ExtrudedSolid): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "Beton", color: "#999999" }] as Project["components"],
    wallTypes: [{ id: "aw", name: "Aussenwand", layers: [{ componentId: "c", thickness: 0.3 }] }],
    ceilingTypes: [{ id: "ct", name: "Decke", layers: [{ componentId: "c", thickness: 0.25 }] }],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 3, cutHeight: 1.0, baseElevation: 0 }],
    layers: [
      { code: "20", name: "Wände", color: "#000000", lw: 0.5, visible: true, locked: false },
      { code: "90", name: "Körper", color: "#000000", lw: 0.25, visible: true, locked: false },
    ],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
    extrudedSolids: [s],
  } as Project;
}

const ctxOf = (p: Project, solidId: string | null): CommandContext =>
  ({
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "90",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null, drawingIds: [], extrudedSolidId: solidId },
  }) as CommandContext;

describe("solidToPartsCommand", () => {
  it("Name und Kürzel", () => {
    expect(resolveCommand("solidtoparts")?.name).toBe("solidtoparts");
    expect(resolveCommand("koerperinbauteile")?.name).toBe("solidtoparts");
  });

  it("gewählter Körper 9 m: drei Geschosse (zwei neu), 6 Wände je Geschoss, 2 Decken, Flachdach, Körper weg", () => {
    const p = project(solid(9));
    const r = solidToPartsCommand.autoRun!(ctxOf(p, "K"));
    expect(r.done).toBe(true);
    expect(r.notice).toMatchObject({ key: "cmd.solidtoparts.done", params: { stories: 3, newFloors: 2, walls: 18, ceilings: 2 } });
    const next = r.commit!(p);
    expect(next.extrudedSolids ?? []).toHaveLength(0);
    const floors = next.drawingLevels.filter((l) => l.kind === "floor");
    expect(floors.map((f) => [f.name, f.baseElevation, f.floorHeight])).toEqual([
      ["EG", 0, 3],
      ["Geschoss 2", 3, 3],
      ["Geschoss 3", 6, 3],
    ]);
    expect(next.walls).toHaveLength(18);
    expect(next.walls.every((w) => w.wallTypeId === "aw" && w.height === 3 && w.referenceLine === "left" && w.isExternal)).toBe(true);
    expect(next.walls.filter((w) => w.floorId === "eg")).toHaveLength(6);
    expect((next.ceilings ?? []).map((c) => c.ceilingTypeId)).toEqual(["ct", "ct"]);
    expect(next.roofs).toHaveLength(1);
    expect(next.roofs![0]).toMatchObject({ shape: "flach", overhang: 0, floorId: floors[2].id });
  });

  it("lehnt verjüngte Körper und Körper zwischen Geschossen mit Meldung ab (kein Commit)", () => {
    const tapered = solidToPartsCommand.autoRun!(ctxOf(project(solid(6, { taper: 0.4 })), "K"));
    expect(tapered).toMatchObject({ done: true, notice: { key: "cmd.solidtoparts.reject.tapered", kind: "warning" } });
    expect(tapered.commit).toBeUndefined();
    const floating = solidToPartsCommand.autoRun!(ctxOf(project(solid(6, { baseOffset: 1.3 })), "K"));
    expect(floating.notice?.key).toBe("cmd.solidtoparts.reject.base");
    expect(floating.commit).toBeUndefined();
  });

  it("ohne Auswahl: Klick in den Körper wandelt um, Klick daneben meldet", () => {
    const p = project(solid(3));
    const ctx = ctxOf(p, null);
    expect(solidToPartsCommand.autoRun!(ctx).done).toBeFalsy();
    const [, miss] = solidToPartsCommand.onInput(solidToPartsCommand.init(), { kind: "point", point: { x: 8, y: 7 } }, ctx);
    expect(miss.commit).toBeUndefined();
    expect(miss.notice?.key).toBe("cmd.solidtoparts.noSolid");
    const [, hit] = solidToPartsCommand.onInput(solidToPartsCommand.init(), { kind: "point", point: { x: 1, y: 1 } }, ctx);
    const next = hit.commit!(p);
    expect(next.walls).toHaveLength(6);
    expect(next.ceilings).toHaveLength(0);
    expect(next.roofs).toHaveLength(1);
  });
});
