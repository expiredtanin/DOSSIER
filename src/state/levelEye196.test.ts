// [196] Auge einer Zeichnungsebene: schaltet nur die eigene; in „Nur aktive"/„Alle anzeigen" werden die Flags vorher
// auf das eingefroren, was der Modus zeigt (sonst erschienen beim Umschalten auf „Ausgewählte" alle Geschosse).
import { beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { frozenLevelFlags, hiddenFloorIds, itemDisplay } from "../panels/displayMode";

beforeEach(() => {
  setState({ project: sampleProject });
  getState().clearHistory();
});

const flags = () => Object.fromEntries(getState().project.drawingLevels.map((l) => [l.id, l.visible]));

describe("Auge der Zeichnungsebenen [196]", () => {
  it("frozenLevelFlags: nur in all_force/active, sonst null", () => {
    const lv = getState().project.drawingLevels;
    expect(frozenLevelFlags("all", lv, "eg")).toBeNull();
    expect(frozenLevelFlags("grey", lv, "eg")).toBeNull();
    const act = frozenLevelFlags("active", lv, "eg")!;
    expect(act.eg).toBe(true);
    expect(Object.entries(act).filter(([, v]) => v).map(([k]) => k)).toEqual(["eg"]);
    expect(Object.values(frozenLevelFlags("all_force", lv, "eg")!).every(Boolean)).toBe(true);
  });

  it("Klick auf das Auge einer Ansicht in „Nur aktive“ ändert nur diese Ebene (ein Undo-Schritt)", () => {
    const lv = getState().project.drawingLevels;
    const view = lv.find((l) => l.kind === "elevation")!;
    const frozen = frozenLevelFlags("active", lv, "eg")!;
    const wasOn = frozen[view.id];
    getState().toggleLevelVisible(view.id, frozen);
    const after = flags();
    // Geschosse nach dem eingefrorenen Modus (nur EG an), die Ansicht umgeschaltet.
    for (const l of lv) expect(after[l.id]).toBe(l.id === view.id ? !wasOn : frozen[l.id]);
    expect(hiddenFloorIds(getState().project.drawingLevels, (id) => itemDisplay("all", id === "eg", after[id])).sort()).toEqual(lv.filter((l) => l.kind === "floor" && l.id !== "eg").map((l) => l.id).sort());
    getState().undo();
    expect(flags()).toEqual(Object.fromEntries(lv.map((l) => [l.id, l.visible])));
  });

  it("ohne frozen: nur die eine Ebene", () => {
    const before = flags();
    getState().toggleLevelVisible("og");
    expect(flags()).toEqual({ ...before, og: !before.og });
  });

  it("hiddenFloorIds: nur Geschosse mit Auge aus", () => {
    const levels = [{ id: "a", kind: "floor" }, { id: "b", kind: "floor" }, { id: "s", kind: "section" }];
    expect(hiddenFloorIds(levels, (id) => ({ render: id === "a" }))).toEqual(["b"]);
  });
});
