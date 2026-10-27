import { describe, expect, it } from "vitest";
import { autodimCommand } from "./autodim";
import { sampleProject } from "../../model/sampleProject";
import type { CommandContext } from "../types";

const ctx = (p = sampleProject, levelId = "eg"): CommandContext => ({
  project: p,
  level: p.drawingLevels.find((l) => l.id === levelId)!,
  defaultCategoryCode: "80",
  activeLineStyleId: "solid",
  activeWallTypeId: "aw",
  lastPoint: null,
  selection: { wallIds: [], drawingId: null },
});

describe("Befehl Aussenbemassung", () => {
  it("fügt Massketten hinzu; erneut ausgeführt ersetzt er sie statt zu verdoppeln", () => {
    const r1 = autodimCommand.autoRun!(ctx());
    const p1 = r1.commit!(sampleProject);
    const added = p1.drawings2d.length - sampleProject.drawings2d.length;
    expect(added).toBeGreaterThanOrEqual(4);
    const p2 = autodimCommand.autoRun!(ctx(p1)).commit!(p1);
    expect(p2.drawings2d.length).toBe(p1.drawings2d.length);
    expect(p2.drawings2d.filter((d) => d.geom.shape === "dimension" && d.levelId === "eg").length).toBeGreaterThanOrEqual(4);
  });
  it("nicht in Schnitt-/Zeichnungsebenen", () => {
    const sec = sampleProject.drawingLevels.find((l) => l.kind !== "floor")!;
    expect(autodimCommand.autoRun!(ctx(sampleProject, sec.id)).commit).toBeUndefined();
  });
});
