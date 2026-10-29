// Verlaufsliste [84]: Beschriftungen der Schritte und Sprung zu einem Schritt über den Store.

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { withHistoryLabel } from "./historySlice";
import { historyLabelText, opsLabel } from "./historyLabels";

beforeEach(() => {
  setState({ project: sampleProject, undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
  getState().clearHistory();
});

const egVisible = () => getState().project.drawingLevels.find((l) => l.id === "eg")?.visible;

describe("Verlaufsliste", () => {
  it("Schritte tragen Beschriftungen (explizit, Gruppe)", () => {
    getState().toggleLevelVisible("eg");
    withHistoryLabel("Eigenschaft ändern: Dicke", () => getState().toggleLevelVisible("eg"));
    getState().groupChanges(
      () => {
        getState().toggleLevelVisible("eg");
        getState().toggleLevelVisible("eg");
      },
      undefined,
      "history.import",
    );
    const { undo, redo } = getState().historyEntries();
    expect(undo).toHaveLength(3);
    expect(undo[0]).toBe("history.op.replace:drawingLevels");
    expect(undo[1]).toBe("Eigenschaft ändern: Dicke");
    expect(undo[2]).toBe("history.import");
    expect(redo).toEqual([]);
  });

  it("Anzeigetexte: Schlüssel, Ops-Ableitung, freier Text, Standard", () => {
    expect(opsLabel([])).toBe("");
    expect(opsLabel([{ kind: "add", collection: "walls", items: [] }])).toBe("history.op.add:walls");
    expect(historyLabelText("Eigenschaft ändern: Dicke")).toBe("Eigenschaft ändern: Dicke");
    expect(historyLabelText("")).toBe("Änderung");
    expect(historyLabelText("history.op.add:walls")).toBe("Wand hinzufügen");
    expect(historyLabelText("history.op.replace:unbekannt")).toBe("unbekannt ändern");
    expect(historyLabelText("history.gibtsnicht")).toBe("Änderung");
    expect(historyLabelText("history.cmd.wall")).toBe("Wand zeichnen");
  });

  it("jumpHistory springt über mehrere Schritte und zurück", () => {
    const start = egVisible();
    for (let i = 0; i < 3; i++) getState().toggleLevelVisible("eg");
    const after3 = egVisible();
    expect(after3).toBe(!start);
    getState().jumpHistory(1);
    expect(getState().undoDepth).toBe(1);
    expect(getState().redoDepth).toBe(2);
    expect(egVisible()).toBe(!start);
    expect(getState().historyEntries().redo).toHaveLength(2);
    getState().jumpHistory(0);
    expect(egVisible()).toBe(start);
    expect(getState().canUndo).toBe(false);
    getState().jumpHistory(3);
    expect(egVisible()).toBe(after3);
    expect(getState().canRedo).toBe(false);
    getState().jumpHistory(99);
    expect(getState().undoDepth).toBe(3);
  });
});
