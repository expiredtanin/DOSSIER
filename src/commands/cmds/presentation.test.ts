import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, ALIASES } from "../registry";
import { setPresentationDialogOpener } from "../../state/presentationSheetHook";
import { createPresentationSheet } from "../../state/presentationSheet";
import { getState } from "../../state/appStore";
import { buildComplexSampleProject } from "../../model/sampleProjectComplex";
import { presentationDefaults } from "../../core";

describe("[66] Befehl praesentation", () => {
  beforeEach(() => {
    getState().loadProject(buildComplexSampleProject());
    getState().clearHistory();
  });

  it("Aliase führen auf den Befehl, der den Dialog öffnet", () => {
    expect(ALIASES.praesentationsplan).toBe("praesentation");
    expect(ALIASES.presentation).toBe("praesentation");
    let opened = 0;
    setPresentationDialogOpener(() => opened++);
    const res = COMMANDS.praesentation.autoRun!({} as never);
    expect(res.done).toBe(true);
    expect(opened).toBe(1);
    setPresentationDialogOpener(null);
  });

  it("Bestätigen legt das Blatt in EINEM Undo-Schritt an", () => {
    const before = getState().project;
    const o = presentationDefaults(before);
    const id = createPresentationSheet({ ...o, sketch: true });
    expect(id).toBeTruthy();
    const p = getState().project;
    const lay = p.layouts!.find((l) => l.id === id)!;
    expect(lay.viewports.length).toBeGreaterThanOrEqual(o.floors.length);
    expect(p.drawingLevels.some((l) => l.sketch)).toBe(true);
    expect(getState().undoDepth).toBe(1);
    getState().undo();
    const q = getState().project;
    expect(q.layouts?.some((l) => l.id === id)).toBe(false);
    expect(q.drawingLevels.some((l) => l.sketch)).toBe(false);
    expect(q.drawingLevels.length).toBe(before.drawingLevels.length);
  });
});
