// [195b] Wandtyp bei Mehrfachauswahl: gilt für alle gewählten Wände, ein Undo-Schritt.
import { describe, expect, it } from "vitest";
import { getState, setState } from "../appStore";
import { buildComplexSampleProject } from "../../model/sampleProjectComplex";
import { EMPTY_SELECTION } from "../selection";
import { buildElementAttributesHost } from "./elementAttributesHost";
import type { FlatHostOpts } from "./types";

describe("onSetWallType [195b]", () => {
  it("setzt den Typ aller gewählten Wände in einem Schritt", () => {
    getState().loadProject(buildComplexSampleProject());
    const [a, b] = getState().project.walls;
    const target = getState().project.wallTypes.find((t) => t.id !== a.wallTypeId && t.id !== b.wallTypeId)!;
    setState({ selection: { ...EMPTY_SELECTION, walls: [a.id, b.id] } });
    const s = getState();
    const host = buildElementAttributesHost({
      applyChange: s.applyChange,
      updateWall: s.updateWall,
      selection: { kind: "wall", id: a.id },
    } as unknown as FlatHostOpts) as { onSetWallType: (id: string) => void };
    const depth = getState().undoDepth;
    host.onSetWallType(target.id);
    const walls = getState().project.walls;
    expect(walls.find((w) => w.id === a.id)!.wallTypeId).toBe(target.id);
    expect(walls.find((w) => w.id === b.id)!.wallTypeId).toBe(target.id);
    expect(getState().undoDepth).toBe(depth + 1);
  });
});
