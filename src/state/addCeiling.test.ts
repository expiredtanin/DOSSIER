// [100] Deckenspiegel: „+ Deckenspiegel“ legt eine Ebene kind "ceiling" für das aktive Geschoss an; ihr Plan
// kommt aus dem Kern (Wände des Geschosses, Untersicht der Decke darüber), der Grundriss bleibt unverändert.
import { beforeEach, describe, expect, it } from "vitest";
import { getState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { generatePlan } from "../plan/generatePlan";

const st = () => getState();

beforeEach(() => {
  st().loadProject(structuredClone(sampleProject));
  st().clearHistory();
});

describe("Deckenspiegel anlegen ([100])", () => {
  it("bezieht sich auf das aktive Geschoss und zeigt dessen Wände und Deckenuntersicht", () => {
    const floor = st().project.drawingLevels.find((l) => l.kind === "floor")!;
    st().setActiveLevelId(floor.id);
    st().addCeiling();
    const lvl = st().project.drawingLevels.find((l) => l.kind === "ceiling");
    expect(lvl?.ceilingOfId).toBe(floor.id);
    const codes = new Set(st().project.layers.flatMap((c) => [c.code, ...(c.children ?? []).map((k) => k.code)]));
    const plan = generatePlan(st().project, lvl!.id, codes);
    const prims = plan.primitives as Array<{ kind: string; wallId?: string; ceilingId?: string; cls?: string }>;
    expect(prims.some((q) => q.wallId)).toBe(true);
    expect(prims.some((q) => q.ceilingId)).toBe(true);
    expect(prims.some((q) => q.cls === "door-swing" || q.cls === "door-leaf")).toBe(false);
    st().undo();
    expect(st().project.drawingLevels.some((l) => l.kind === "ceiling")).toBe(false);
  });
});
