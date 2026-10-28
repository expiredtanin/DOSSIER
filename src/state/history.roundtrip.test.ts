// Maintainer-Fund 28.10.: mehrmals ganz zurück und wieder vor — der Redo-Stapel darf dabei nicht verloren gehen,
// auch nicht mit überzähligen Undo/Redo-Aufrufen an den Enden.
import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { emptyProject } from "../model/sampleProject";

beforeEach(() => {
  setState({ project: emptyProject, undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
  getState().clearHistory();
});

describe("Undo/Redo über den Anfang hinaus", () => {
  it("drei Schritte, mehrmals ganz zurück und vor", () => {
    for (const name of ["A", "B", "C"]) getState().setProject((p) => ({ ...p, name }));
    expect(getState().project.name).toBe("C");
    for (let round = 0; round < 3; round++) {
      for (let k = 0; k < 6; k++) getState().undo();
      expect(getState().project.name).toBe(emptyProject.name);
      for (let k = 0; k < 6; k++) getState().redo();
      expect(getState().project.name).toBe("C");
    }
  });
});
