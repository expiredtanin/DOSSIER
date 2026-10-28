/**
 * Undo/Redo für das Projekt-Modell (`src/state/historySlice.ts` +
 * `setProject`-Wrapper in `src/state/projectSlice.ts`).
 *
 *  • Ein diskreter Store-Aufruf (z. B. `toggleLevelVisible`) muss GENAU einen
 *    Undo-Schritt erzeugen.
 *  • `undo`/`redo` müssen den jeweils anderen Stack korrekt befüllen und
 *    dürfen bei leerem Stack nicht crashen (No-Op).
 *  • Eine neue Aktion nach `undo()` muss den Redo-Stack verwerfen.
 *  • Hochfrequente Drag-Aktionen (z. B. `moveGripOf`, bei JEDEM Maus-Move-
 *    Schritt aufgerufen statt über ein Draft/Commit-Muster) müssen zu EINEM
 *    Undo-Schritt koalesziert werden, nicht zu einem pro Aufruf.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { HISTORY_LIMIT } from "./historySlice";

// Frischen Ausgangszustand vor jedem Test herstellen: eigenes Projekt +
// leere Stacks, damit die Tests unabhängig voneinander laufen (derselbe
// Store ist ein Singleton über die ganze Datei hinweg).
beforeEach(() => {
  setState({
    project: sampleProject,
    undoDepth: 0,
    redoDepth: 0,
    canUndo: false,
    canRedo: false,
  });
  getState().clearHistory();
});

describe("Undo/Redo", () => {
  it("undo macht eine Projekt-Änderung rückgängig", () => {
    const before = getState().project;
    getState().toggleLevelVisible("eg");
    const afterToggle = getState().project;

    expect(afterToggle).not.toBe(before);
    expect(afterToggle.drawingLevels.find((l) => l.id === "eg")?.visible).toBe(false);
    expect(getState().canUndo).toBe(true);

    getState().undo();

    expect(getState().project.drawingLevels.find((l) => l.id === "eg")?.visible).toBe(true);
    expect(getState().canUndo).toBe(false);
    expect(getState().canRedo).toBe(true);
  });

  it("redo stellt die rückgängig gemachte Änderung wieder her", () => {
    getState().toggleLevelVisible("eg");
    getState().undo();

    getState().redo();

    expect(getState().project.drawingLevels.find((l) => l.id === "eg")?.visible).toBe(false);
    expect(getState().canRedo).toBe(false);
    expect(getState().canUndo).toBe(true);
  });

  it("undo bei leerem Stack ist ein No-Op (kein Crash)", () => {
    expect(getState().undoDepth).toBe(0);
    const before = getState().project;

    expect(() => getState().undo()).not.toThrow();

    expect(getState().project).toBe(before);
    expect(getState().canUndo).toBe(false);
  });

  it("redo bei leerem Stack ist ein No-Op (kein Crash)", () => {
    expect(getState().redoDepth).toBe(0);
    const before = getState().project;

    expect(() => getState().redo()).not.toThrow();

    expect(getState().project).toBe(before);
    expect(getState().canRedo).toBe(false);
  });

  it("eine neue Aktion nach undo() verwirft den Redo-Stack", () => {
    getState().toggleLevelVisible("eg");
    getState().undo();
    expect(getState().redoDepth).toBe(1);

    getState().toggleLevelVisible("og");

    expect(getState().redoDepth).toBe(0);
    expect(getState().canRedo).toBe(false);
    // Die neue Aktion selbst bleibt natürlich undo-fähig.
    expect(getState().canUndo).toBe(true);
  });

  it("die allererste Änderung bleibt exakt EIN Undo-Schritt (kein Start-Eintrag)", () => {
    expect(getState().undoDepth).toBe(0);
    getState().toggleLevelVisible("eg");
    expect(getState().undoDepth).toBe(1);
  });

  it("history-Stack verwirft die ältesten Einträge über HISTORY_LIMIT hinaus", () => {
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      getState().toggleLevelVisible("eg");
    }
    expect(getState().undoDepth).toBe(HISTORY_LIMIT);
  });

  it("ein Grip-Drag (viele setProject-Aufrufe in Serie) koalesziert zu EINEM Undo-Schritt", () => {
    const w1Before = getState().project.walls.find((w) => w.id === "W1");
    expect(w1Before?.start).toEqual({ x: 0, y: 0 });

    // Simuliert einen Drag: viele schnelle moveGripOf-Aufrufe auf DASSELBE
    // Element/denselben Griff, wie sie bei jedem Maus-Move-Event entstehen
    // (siehe gripHandlers.onGripMove in App.tsx → moveGripOf).
    for (let i = 1; i <= 20; i++) {
      getState().moveGripOf(null, "W1", 0, { x: i * 0.1, y: 0 });
    }

    const w1After = getState().project.walls.find((w) => w.id === "W1");
    expect(w1After?.start).toEqual({ x: 2, y: 0 });
    // Trotz 20 Aufrufen: genau EIN Undo-Schritt.
    expect(getState().undoDepth).toBe(1);

    getState().undo();

    const w1Restored = getState().project.walls.find((w) => w.id === "W1");
    expect(w1Restored?.start).toEqual({ x: 0, y: 0 });
    expect(getState().undoDepth).toBe(0);
  });

  it("zwei Drags auf UNTERSCHIEDLICHE Griffe erzeugen ZWEI Undo-Schritte", () => {
    getState().moveGripOf(null, "W1", 0, { x: 1, y: 0 });
    getState().moveGripOf(null, "W1", 1, { x: 6, y: 0 });

    expect(getState().undoDepth).toBe(2);
  });
});
