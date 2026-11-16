// [266] Projektname über Ops änderbar (ein Undo-Schritt), leerer Name wird ignoriert.
import { describe, expect, it } from "vitest";
import { getState } from "../appStore";
import { emptyProject } from "../../model/sampleProject";
import { buildLayoutsHost } from "./layoutsHost";
import type { FlatHostOpts } from "./types";

describe("onSetProjectName [266]", () => {
  it("setzt den Namen, Undo stellt ihn zurück, leer ändert nichts", () => {
    getState().loadProject(emptyProject);
    const s = getState();
    const host = buildLayoutsHost({ applyChange: s.applyChange, project: s.project } as unknown as FlatHostOpts);
    const before = getState().project.name;
    const depth = getState().undoDepth;
    host.onSetProjectName("Haus am See");
    expect(getState().project.name).toBe("Haus am See");
    expect(getState().undoDepth).toBe(depth + 1);
    host.onSetProjectName("   ");
    expect(getState().project.name).toBe("Haus am See");
    getState().undo();
    expect(getState().project.name).toBe(before);
  });
});
