/**
 * Fällt die aktive Ebene durch eine Projektänderung weg (Undo einer angelegten Zeichnungsebene,
 * z. B. „Räume generieren"), springt `activeLevelId` auf eine vorhandene Ebene, ohne Undo-Schritt.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";

beforeEach(() => {
  setState({ project: sampleProject, activeLevelId: "eg" });
  getState().clearHistory();
});

describe("aktive Ebene nach Undo/Redo", () => {
  it("fällt nach Undo einer neuen Zeichnungsebene auf die zuvor aktive Ebene zurück", () => {
    getState().setActiveLevelId("og");
    const id = getState().addDrawingLevel("Blatt");
    getState().setActiveLevelId(id);
    const depth = getState().undoDepth;
    getState().undo();
    expect(getState().project.drawingLevels.some((l) => l.id === id)).toBe(false);
    expect(getState().activeLevelId).toBe("og");
    expect(getState().undoDepth).toBe(depth - 1);
    // Redo bringt die Ebene zurück; die aktive Ebene bleibt gültig, kein zusätzlicher Schritt.
    getState().redo();
    expect(getState().project.drawingLevels.some((l) => l.id === id)).toBe(true);
    expect(getState().activeLevelId).toBe("og");
    expect(getState().undoDepth).toBe(depth);
  });

  it("nimmt das erste Geschoss, wenn die aktive Ebene fehlt und keine frühere bekannt ist", () => {
    setState({ activeLevelId: "gibt-es-nicht" });
    getState().toggleLevelVisible("eg");
    expect(getState().activeLevelId).toBe("eg");
  });
});
