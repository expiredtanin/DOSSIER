/**
 * `roofHoleCommand` — Innenhof per Klicks (≥ 3 Punkte Polygon, 2 Punkte + Enter Rechteck) im ersten
 * Dach des aktiven Geschosses, in dem er wirkt; sonst bleibt das Projekt unverändert.
 */
import { describe, expect, it } from "vitest";
import { roofHoleCommand } from "./roofHole";
import type { CommandContext, CommandState, Project, Vec2 } from "../types";

const roof = (id: string, shape: "walm" | "pult", x0: number) => ({
  id,
  type: "roof" as const,
  floorId: "eg",
  categoryCode: "31",
  outline: [
    { x: x0, y: 0 },
    { x: x0 + 12, y: 0 },
    { x: x0 + 12, y: 8 },
    { x: x0, y: 8 },
  ],
  shape,
  pitchDeg: 35,
  overhang: 0,
  ridgeAxis: "x" as const,
  thickness: 0.2,
});

function project(shape: "walm" | "pult" = "walm"): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }],
    layers: [{ code: "31", name: "Dächer", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
    roofs: [roof("RF1", shape, 0)],
  };
}

const ctxOf = (p: Project): CommandContext => ({
  project: p,
  level: p.drawingLevels[0],
  defaultCategoryCode: "31",
  activeLineStyleId: "solid",
  activeWallTypeId: "aw",
  lastPoint: null,
  selection: { wallIds: [], drawingId: null },
});

/** Befehl mit Punkten füttern und mit Enter bestätigen; liefert das Ergebnis-Projekt. */
function run(p: Project, pts: Vec2[], confirm = true): Project {
  const ctx = ctxOf(p);
  let state: CommandState = roofHoleCommand.init();
  let commit: ((q: Project) => Project) | undefined;
  for (const point of pts) {
    const [ns, res] = roofHoleCommand.onInput(state, { kind: "point", point }, ctx);
    state = ns;
    commit = res.commit ?? commit;
  }
  if (confirm && !commit) {
    const [, res] = roofHoleCommand.onConfirm(state, ctx);
    commit = res.commit;
  }
  return commit ? commit(p) : p;
}

describe("roofHoleCommand", () => {
  it("zwei Punkte + Enter ergeben einen rechteckigen Hof", () => {
    const p = project();
    const q = run(p, [{ x: 4, y: 2 }, { x: 8, y: 6 }]);
    expect(q.roofs![0].holes).toEqual([
      [
        { x: 4, y: 2 },
        { x: 8, y: 2 },
        { x: 8, y: 6 },
        { x: 4, y: 6 },
      ],
    ]);
  });

  it("drei und mehr Punkte: Klick auf den Startpunkt schliesst das Polygon", () => {
    const q = run(project(), [{ x: 3, y: 2 }, { x: 9, y: 2 }, { x: 6, y: 6 }, { x: 3, y: 2 }], false);
    expect(q.roofs![0].holes).toHaveLength(1);
    expect(q.roofs![0].holes![0]).toHaveLength(3);
  });

  it("Hof ausserhalb des Dachs oder bei Pultdach: Projekt unverändert", () => {
    const p = project();
    expect(run(p, [{ x: 20, y: 2 }, { x: 24, y: 6 }]).roofs![0].holes).toBeUndefined();
    const pult = project("pult");
    expect(run(pult, [{ x: 4, y: 2 }, { x: 8, y: 6 }]).roofs![0].holes).toBeUndefined();
  });

  it("Hof über den Umriss hinaus wird verworfen", () => {
    expect(run(project(), [{ x: 10, y: 2 }, { x: 14, y: 6 }]).roofs![0].holes).toBeUndefined();
  });
});
