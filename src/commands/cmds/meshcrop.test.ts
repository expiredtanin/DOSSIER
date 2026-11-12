// [193] Netz auf frei gezeichnetes Polygon zuschneiden: Voraussetzung ein gewähltes Netz, Kern-Befehl `meshCrop`.
import { describe, expect, it } from "vitest";
import { sampleProject } from "../../model/sampleProject";
import type { ContextObject, Project } from "../../model/types";
import type { CommandContext, CmdInput } from "../types";
import { meshCropCommand } from "./meshcrop";

const mesh = {
  id: "tm", type: "terrainMesh", categoryCode: "02", name: "Gelände",
  positions: [0, 0, 1, 2, 0, 2, 2, 2, 3, 0, 2, 4], indices: [0, 1, 2, 0, 2, 3],
} as unknown as ContextObject;
const proj: Project = { ...sampleProject, context: [mesh] };

function ctxOf(p: Project, contextIds: string[]): CommandContext {
  return {
    project: p,
    level: p.drawingLevels.find((l) => l.kind === "floor")!,
    defaultCategoryCode: p.layers[0].code,
    activeLineStyleId: "solid",
    activeWallTypeId: p.wallTypes[0]?.id ?? "",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null, drawingIds: [], contextIds } as unknown as CommandContext["selection"],
  };
}

function draw(ctx: CommandContext, pts: [number, number][]) {
  let st = meshCropCommand.init();
  for (const [x, y] of pts) st = meshCropCommand.onInput(st, { kind: "point", point: { x, y } } as CmdInput, ctx)[0];
  return meshCropCommand.onConfirm(st, ctx)[1];
}

describe("[193] Netz zuschneiden (Befehl)", () => {
  it("ohne gewähltes Netz startet er nicht", () => {
    expect(meshCropCommand.precondition?.(ctxOf(proj, []))).toBe("cmd.meshcrop.noMesh");
    expect(meshCropCommand.precondition?.(ctxOf(proj, ["nix"]))).toBe("cmd.meshcrop.noMesh");
    expect(meshCropCommand.precondition?.(ctxOf(proj, ["tm"]))).toBeNull();
  });
  it("Polygon um die linke Hälfte: ein Dreieck bleibt", () => {
    const ctx = ctxOf(proj, ["tm"]);
    const res = draw(ctx, [[-1, -1], [1, -1], [1, 3], [-1, 3]]);
    expect(res.done).toBe(true);
    expect(res.commit).toBeDefined();
    const out = res.commit!(proj);
    expect((out.context![0] as unknown as { indices: number[] }).indices).toEqual([0, 1, 2]);
  });
  it("Polygon um alles / ausserhalb: nichts, mit Hinweis", () => {
    const ctx = ctxOf(proj, ["tm"]);
    const all = draw(ctx, [[-1, -1], [3, -1], [3, 3], [-1, 3]]);
    expect(all.commit).toBeUndefined();
    expect(all.notice?.key).toBe("cmd.meshcrop.nothing");
    const far = draw(ctx, [[10, 10], [11, 10], [11, 11]]);
    expect(far.commit).toBeUndefined();
  });
  it("zwei Punkte = Rechteck aus den Ecken", () => {
    const res = draw(ctxOf(proj, ["tm"]), [[-1, -1], [1, 3]]);
    expect(res.commit).toBeDefined();
  });
});
