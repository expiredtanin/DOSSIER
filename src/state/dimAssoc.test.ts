// [38] Assoziative Bemassung im Store: eine an Wandenden gefangene Bemassung folgt der Wand (Kern
// führt `pts` im selben Undo-Schritt nach), „Bemassung lösen" macht sie wieder frei.
import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { emptyProject } from "../model/sampleProject";
import { addItems, cmdMutation, patchItem } from "../core";
import type { Drawing2D, Wall } from "../model/types";

const wall: Wall = {
  id: "W1",
  type: "wall",
  floorId: "eg",
  categoryCode: "21",
  start: { x: 0, y: 0 },
  end: { x: 5, y: 0 },
  wallTypeId: "aw",
  height: 2.6,
} as Wall;

const dim = (): Drawing2D | undefined => getState().project.drawings2d.find((d) => d.geom.shape === "dimension");
const len = (d: Drawing2D | undefined): number => {
  if (d?.geom.shape !== "dimension") return NaN;
  const [a, b] = d.geom.pts;
  return Math.hypot(b.x - a.x, b.y - a.y);
};

beforeEach(() => {
  setState({ project: emptyProject, undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
  getState().clearHistory();
  getState().applyChange(addItems("walls", [wall]));
});

describe("assoziative Bemassung [38]", () => {
  it("Wand strecken → Masszahl folgt, ein Undo-Schritt", () => {
    getState().setProject(
      cmdMutation({ cmd: "dimension", pts: [[0, 0], [5, 0]], snaps: [[0, 0], [5, 0]], offset: 1, ctx: { level: "eg" }, stamp: "t" }),
    );
    const d0 = dim();
    expect(d0?.geom.shape === "dimension" && d0.geom.refs?.map((r) => r?.feature)).toEqual(["wall", "wall"]);
    expect(len(d0)).toBeCloseTo(5, 9);

    getState().applyChange((p) => patchItem(p, "walls", "W1", { end: { x: 7.25, y: 0 } }));
    expect(len(dim())).toBeCloseTo(7.25, 9);

    getState().undo();
    expect(len(dim())).toBeCloseTo(5, 9);
    expect(getState().project.walls[0].end.x).toBe(5);
    getState().redo();
    expect(len(dim())).toBeCloseTo(7.25, 9);
  });

  it("freie Punkte bleiben frei; Lösen entfernt die Bezüge", () => {
    getState().setProject(cmdMutation({ cmd: "dimension", pts: [[0, 0], [3, 3]], offset: 1, ctx: { level: "eg" }, stamp: "t" }));
    const free = dim();
    // Punkt (0, 0) deckt sich mit dem Wandanfang, (3, 3) ist frei.
    expect(free?.geom.shape === "dimension" && free.geom.refs?.map((r) => r?.feature ?? null)).toEqual(["wall", null]);
    getState().setProject(cmdMutation({ cmd: "dimdetach", ids: [free!.id] }));
    const d = dim();
    expect(d?.geom.shape === "dimension" && d.geom.refs).toBeUndefined();
    getState().applyChange((p) => patchItem(p, "walls", "W1", { start: { x: -1, y: 0 } }));
    expect(dim()?.geom).toEqual(d?.geom);
  });
});
