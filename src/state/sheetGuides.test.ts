// [208] Hilfslinien des Blatts: am Master gespeichert, ein Undo-Schritt je Zug, löschbar.
import { describe, expect, it, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { emptyProject } from "../model/sampleProject";
import { addItems } from "../core";
import { createLayout, createMasterLayout } from "../model/layoutModel";
import { setSheetGuidesOps } from "./sheetGuides";
import { addGuide, moveGuide, removeGuide } from "../ui/sheetSnap";

const guidesOf = () => getState().project.masterLayouts?.find((m) => m.id === "m1")?.guides;

beforeEach(() => {
  setState({ project: emptyProject, undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
  getState().clearHistory();
  const m = createMasterLayout("m1", "Master", "a1", "landscape");
  const l = { ...createLayout("l1", "Blatt", "a1", "landscape"), masterId: "m1" };
  getState().applyChange([...addItems("masterLayouts", [m]), ...addItems("layouts", [l])]);
  getState().clearHistory();
});

describe("Hilfslinien am Master", () => {
  it("setzen, verschieben (Zug = ein Undo-Schritt), löschen", () => {
    getState().applyChange((p) => setSheetGuidesOps(p, "l1", addGuide(guidesOf(), "x", 40)));
    expect(guidesOf()).toEqual([{ axis: "x", posMm: 40 }]);
    // Ein Zug mit mehreren Zwischenständen und gleichem coalesceKey: ein Schritt.
    for (const pos of [41, 42, 45]) {
      getState().applyChange((p) => setSheetGuidesOps(p, "l1", moveGuide(guidesOf(), 0, pos)), "sheetGuide:l1:0");
    }
    expect(guidesOf()).toEqual([{ axis: "x", posMm: 45 }]);
    getState().undo();
    expect(guidesOf()).toEqual([{ axis: "x", posMm: 40 }]);
    getState().applyChange((p) => setSheetGuidesOps(p, "l1", removeGuide(guidesOf(), 0)));
    expect(guidesOf()).toBeUndefined();
    getState().undo();
    expect(guidesOf()).toEqual([{ axis: "x", posMm: 40 }]);
  });

  it("Blatt ohne Master: keine Ops", () => {
    getState().applyChange(addItems("layouts", [createLayout("l2", "Frei", "a1", "landscape")]));
    expect(setSheetGuidesOps(getState().project, "l2", [{ axis: "x", posMm: 1 }])).toEqual([]);
  });
});
