/**
 * [T7] `revolveCommand` (Profil + Achse + Winkel) und `loftCommand` (≥ 2 Profile + Höhe): beide legen
 * einen B-Rep-Körper (`ExtrudedSolid.brep`) an und entfernen die Quellprofile.
 */

import { describe, it, expect } from "vitest";
import { revolveCommand } from "./revolve";
import { loftCommand } from "./loft";
import type { CommandContext, CmdInput, Project } from "../types";

const rect = (id: string, x: number, y: number, w: number, h: number) => ({
  id,
  type: "drawing2d" as const,
  levelId: "eg",
  categoryCode: "20",
  geom: { shape: "rect" as const, min: { x, y }, max: { x: x + w, y: y + h } },
});

function project(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers: [{ code: "20", name: "Zeichnung", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [rect("A", 0, 1, 2, 1), rect("B", 10, 0, 1, 1)],
    extrudedSolids: [],
    context: [],
  } as unknown as Project;
}

function makeCtx(p: Project, drawingId: string | null = null): CommandContext {
  return {
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId },
  } as CommandContext;
}

/** Spielt Eingaben ab; liefert das Projekt nach dem Commit (oder null). */
function run(cmd: typeof revolveCommand, p: Project, inputs: Array<CmdInput | "confirm">, selected: string | null = null) {
  const ctx = makeCtx(p, selected);
  let state = cmd.init();
  let commit: ((p: Project) => Project) | undefined;
  for (const i of inputs) {
    const [ns, res] = i === "confirm" ? cmd.onConfirm(state, ctx) : cmd.onInput(state, i, ctx);
    state = ns;
    if (res.commit) commit = res.commit as typeof commit;
  }
  return commit ? commit(p) : null;
}

const pt = (x: number, y: number): CmdInput => ({ kind: "point", point: { x, y } });

describe("revolveCommand", () => {
  it("Profil wählen, Achse (2 Punkte), Winkel → Rotationskörper, Quelle entfernt", () => {
    const next = run(revolveCommand, project(), [pt(1, 1), pt(-1, 0), pt(5, 0), { kind: "number", value: 180 }])!;
    expect(next.drawings2d.map((d) => d.id)).toEqual(["B"]);
    const s = next.extrudedSolids![0];
    expect(s.brep!.spec).toMatchObject({ kind: "transform", solid: { kind: "revolve", angleDeg: 180 } });
    expect(s.height).toBeCloseTo(4, 9); // Profil 1 … 2 m neben der Achse y=0 → r_max = 2
  });

  it("Enter beim Winkel übernimmt den zuletzt benutzten; vorgewähltes Profil überspringt die Wahl", () => {
    run(revolveCommand, project(), [pt(1, 1), pt(-1, 0), pt(5, 0), { kind: "number", value: 90 }]);
    const next = run(revolveCommand, project(), [pt(-1, 0), pt(5, 0), "confirm"], "A")!;
    expect(next.extrudedSolids![0].brep!.spec).toMatchObject({ solid: { angleDeg: 90 } });
  });

  it("Profil, das die Achse überquert, ergibt keinen Körper", () => {
    const next = run(revolveCommand, project(), [pt(1, 1), pt(-1, 1.5), pt(5, 1.5), "confirm"]);
    expect(next?.extrudedSolids ?? []).toHaveLength(0);
  });
});

describe("loftCommand", () => {
  it("zwei Profile wählen, Enter, Höhe → Loft-Körper, Quellen entfernt", () => {
    const next = run(loftCommand, project(), [pt(1, 1), pt(10.5, 0), "confirm", { kind: "number", value: 3 }])!;
    expect(next.drawings2d).toHaveLength(0);
    const s = next.extrudedSolids![0];
    expect(s.height).toBe(3);
    expect(s.brep!.spec).toMatchObject({ kind: "loft" });
    expect((s.brep!.spec as { sections: unknown[] }).sections).toHaveLength(2);
  });

  it("mit nur einem Profil bleibt Enter wirkungslos", () => {
    const next = run(loftCommand, project(), [pt(1, 1), "confirm", { kind: "number", value: 3 }]);
    expect(next?.extrudedSolids ?? []).toHaveLength(0);
  });
});
