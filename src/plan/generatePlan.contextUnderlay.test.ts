// [285] Kataster/Kontext als Unterlage: im Arbeitsgrundriss (`contextUnderlay`) halbtransparent, Wände darüber bleiben
// lesbar; ohne den Schalter (Druck/Export, CLI) und für andere Klassen deckend. `LayerCategory.underlay` schaltet je Klasse.

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import { isUnderlayCategory } from "../model/layers";
import type { Drawing2D, Project } from "../model/types";

const line = (id: string, code: string): Drawing2D => ({
  id,
  type: "drawing2d",
  levelId: "eg",
  categoryCode: code,
  geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
});

function project(extra: Record<string, unknown> = {}): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers: [
      { code: "05", name: "Kontext", color: "#707078", lw: 0.13, visible: true, locked: false, children: [{ code: "06", name: "Kataster", color: "#707078", lw: 0.13, visible: true, locked: false }] },
      { code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
    ],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [line("k", "05"), line("z", "20")],
    context: [],
    ...extra,
  } as unknown as Project;
}

const visible = new Set(["05", "06", "20"]);
const opacities = (p: Project, underlay: boolean, forPrint = false) => {
  const prims = generatePlan(p, "eg", visible, undefined, "mittel", false, false, true, undefined, forPrint, false, null, null, null, underlay).primitives;
  const by = (id: string) => prims.find((q) => q.kind === "line" && q.drawingId === id) as { opacity?: number } | undefined;
  return { kontext: by("k")?.opacity ?? 1, zeichnung: by("z")?.opacity ?? 1 };
};

describe("[285] Kontext-Klassen als Unterlage", () => {
  it("Arbeitsgrundriss: Kontext halbtransparent, eigene Zeichnung deckend", () => {
    const o = opacities(project(), true);
    expect(o.kontext).toBeLessThan(0.6);
    expect(o.zeichnung).toBe(1);
  });
  it("ohne Schalter (CLI/Export) und im Druck deckend", () => {
    expect(opacities(project(), false).kontext).toBe(1);
    expect(opacities(project(), true, true).kontext).toBe(1);
  });
  it("Klasse ausdrücklich ein-/ausschalten", () => {
    const layers = [
      { code: "05", name: "Kontext", color: "#707078", lw: 0.13, visible: true, locked: false, underlay: false },
      { code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false, underlay: true },
    ];
    const o = opacities(project({ layers }), true);
    expect(o.kontext).toBe(1);
    expect(o.zeichnung).toBeLessThan(0.6);
  });
  it("Vorgabe im Editor: Kontext-Kinder an, andere aus", () => {
    const p = project();
    expect(isUnderlayCategory(p.layers, "06")).toBe(true);
    expect(isUnderlayCategory(p.layers, "20")).toBe(false);
  });
});
