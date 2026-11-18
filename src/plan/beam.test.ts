/**
 * [280] Träger/Unterzug: Befehl `traeger` (zwei Punkte → ein Träger), Grundriss (gestrichelt, Achse), 3D (Prisma),
 * Objekt-Info, Griff, Löschen über den Auswahlkanal der Stützen, Beispielprojekt „Musterhaus komplex“.
 * (Höhenlage, Schnitt längs/quer: Rust-Tests `beam_tests.rs`.)
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import { projectToModel3d } from "./toWalls3d";
import { traegerCommand } from "../commands/cmds/traeger";
import type { CommandContext } from "../commands/types";
import { deriveSelection } from "../state/selectionInfo";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { applyOps } from "../core";
import { lockOps } from "../state/objectLock";
import { beamGripPoints } from "../core";
import type { Beam, Project } from "../model/types";

const beam: Beam = { id: "B1", type: "beam", floorId: "eg", categoryCode: "50", start: { x: 1, y: 2 }, end: { x: 5, y: 2 }, width: 0.25, height: 0.4 };

function project(beams: Beam[]): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#c8c8cc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.3 }] }],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers: [{ code: "50", name: "Tragwerk", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    beams,
    drawings2d: [],
    context: [],
  };
}

describe("Träger — Grundriss, 3D, Objekt-Info", () => {
  it("Grundriss: über der Schnitthöhe, Kanten gestrichelt und Achse als Linie", () => {
    const plan = generatePlan(project([beam]), "eg", new Set(["50"]));
    const prims = plan.primitives;
    expect(prims.some((p) => p.kind === "polygon" && p.columnId === "B1")).toBe(true);
    const dashed = prims.filter((p) => p.kind === "line" && p.dash && p.cls !== "beam-axis");
    expect(dashed.length).toBe(4);
    expect(prims.filter((p) => p.kind === "line" && p.cls === "beam-axis").length).toBe(1);
    // Klasse aus: nichts.
    expect(generatePlan(project([beam]), "eg", new Set()).primitives.filter((p) => p.kind === "polygon" && p.columnId === "B1").length).toBe(0);
  });

  it("3D: ein Prisma 4 m × 25 cm, Oberkante an der Geschoss-Oberkante (keine Decke darüber)", () => {
    const m = projectToModel3d(project([beam]));
    const meshes = m.meshes.filter((x) => x.kind === "extrusion");
    expect(meshes.length).toBe(1);
    const pos = Array.from(meshes[0].positions);
    const z = pos.filter((_, i) => i % 3 === 2);
    expect(Math.max(...z)).toBeCloseTo(2.6, 6);
    expect(Math.min(...z)).toBeCloseTo(2.2, 6);
    const x = pos.filter((_, i) => i % 3 === 0);
    expect(Math.max(...x) - Math.min(...x)).toBeCloseTo(4, 6);
  });

  it("Objekt-Info: kind beam mit Querschnitt, Länge und UK/OK; Griffe Anfang, Ende, Mitte", () => {
    const p = project([{ ...beam, profileName: "HEB 200", topOffset: 0.1 }]);
    const info = deriveSelection(p, { columns: ["B1"] });
    expect(info?.kind).toBe("beam");
    expect(info?.beam).toMatchObject({ width: 0.25, height: 0.4, profileName: "HEB 200", topOffset: 0.1, length: 4 });
    expect(info?.beam?.zTop).toBeCloseTo(2.7, 6);
    expect(beamGripPoints(beam)).toEqual([{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 3, y: 2 }]);
  });

  it("Sperre über den Auswahlkanal der Stützen", () => {
    const p = project([beam]);
    const ops = lockOps(p, "columnIds", "B1", true);
    expect(ops.length).toBe(1);
    const q = applyOps(p, ops);
    expect(q.beams?.[0].locked).toBe(true);
  });
});

describe("Befehl traeger", () => {
  const ctxOf = (p: Project): CommandContext => ({ project: p, level: p.drawingLevels[0], defaultCategoryCode: "50", activeLineStyleId: "thin", activeWallTypeId: "aw", lastPoint: null, selection: { wallIds: [], drawingId: null } });

  it("zwei Punkte legen einen Träger an und beenden den Befehl", () => {
    const p = project([]);
    const ctx = ctxOf(p);
    const [s1, r1] = traegerCommand.onInput(traegerCommand.init(), { kind: "point", point: { x: 0, y: 0 } }, ctx);
    expect(r1.done).toBeFalsy();
    const [, mv] = traegerCommand.onMove!(s1, { x: 3, y: 0 }, null, ctx);
    expect(mv.draft?.preview.length).toBeGreaterThan(0);
    const [, r2] = traegerCommand.onInput(s1, { kind: "point", point: { x: 3, y: 0 } }, ctx);
    expect(r2.done).toBe(true);
    const next = r2.commit!(p);
    expect(next.beams?.length).toBe(1);
    const item = next.beams![0];
    expect(item).toMatchObject({ type: "beam", floorId: "eg", categoryCode: "50", width: 0.25, height: 0.4, end: { x: 3, y: 0 } });
  });

  it("Nulllänge wird ignoriert", () => {
    const p = project([]);
    const ctx = ctxOf(p);
    const [s1] = traegerCommand.onInput(traegerCommand.init(), { kind: "point", point: { x: 1, y: 1 } }, ctx);
    const [s2, r] = traegerCommand.onInput(s1, { kind: "point", point: { x: 1, y: 1 } }, ctx);
    expect(r.done).toBeFalsy();
    expect(s2).toBe(s1);
  });
});

describe("Beispielprojekt Musterhaus komplex", () => {
  it("enthält den Unterzug im EG; Schnitt A-A schneidet ihn quer", () => {
    const p = buildComplexSampleProject();
    const b = p.beams?.find((x) => x.id === "tg-eg-1");
    expect(b).toBeTruthy();
    const plan = generatePlan(p, "eg", new Set(["25", "30", "20"]));
    expect(plan.primitives.some((q) => q.kind === "polygon" && q.columnId === "tg-eg-1")).toBe(true);
  });
});
