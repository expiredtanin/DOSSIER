// [123] Bewegen/Drehen/Spiegeln über die Engine: Punkte, getippte Distanz/Winkel, Kopiermodus
// U/I/O/P (kein Schritt für Esc), Enter = Klick auf die letzte Mausposition, ohne Auswahl kein Start.
import { describe, expect, it } from "vitest";
import { CommandEngine, ESC_DOUBLE_MS, type EngineHost } from "../engine";
import type { CommandContext, CommandSelection, Project } from "../types";
import { sampleProject } from "../../model/sampleProject";

function projectWithLine(): Project {
  return {
    ...sampleProject,
    drawings2d: [
      {
        id: "ln",
        type: "drawing2d",
        levelId: sampleProject.drawingLevels[0].id,
        categoryCode: sampleProject.layers[0].code,
        geom: { shape: "line", a: { x: 0, y: 0 }, b: { x: 2, y: 0 } },
      },
    ],
  };
}

function setup(selection: CommandSelection = { wallIds: [], drawingId: "ln", drawingIds: ["ln"] }) {
  const log = { project: projectWithLine(), notes: [] as string[] };
  const host: EngineHost = {
    context: (lastPoint) =>
      ({
        project: log.project,
        level: log.project.drawingLevels[0],
        defaultCategoryCode: log.project.layers[0].code,
        activeLineStyleId: "",
        activeWallTypeId: "",
        lastPoint,
        selection,
      }) as CommandContext,
    snap: () => null,
    pxPerMeter: () => 50,
    setDraft: () => {},
    commit: (m) => void (log.project = m(log.project)),
    isFloor: () => true,
    notify: (k) => void log.notes.push(k),
  };
  return { engine: new CommandEngine(host), log };
}

const lines = (p: Project) =>
  p.drawings2d.map((d) => {
    if (d.geom.shape !== "line") throw new Error("keine Linie");
    return d.geom;
  });

describe("Transformations-Befehle", () => {
  it("ohne Auswahl startet kein Befehl, sondern ein Hinweis", () => {
    const { engine, log } = setup({ wallIds: [], drawingId: null });
    expect(engine.start("move")).toBe(false);
    expect(engine.isActive()).toBe(false);
    expect(log.notes).toEqual(["transform.needSelection"]);
  });

  it("Bewegen: Basis → Ziel; Prompts wie die frühere Transformation", () => {
    const { engine, log } = setup();
    engine.start("move");
    expect(engine.view().promptKey).toBe("transform.hint.move.0");
    expect(engine.view().options.map((o) => o.key)).toEqual(["U", "I", "O", "P"]);
    engine.pick({ x: 0, y: 0 });
    expect(engine.view().promptKey).toBe("transform.hint.move.1");
    engine.pick({ x: 3, y: 1 });
    expect(engine.isActive()).toBe(false);
    expect(lines(log.project)[0].a).toEqual({ x: 3, y: 1 });
  });

  it("Bewegen: getippte Distanz entlang der Mausrichtung committet sofort", () => {
    const { engine, log } = setup();
    engine.start("move");
    engine.pick({ x: 0, y: 0 });
    engine.move({ x: 0, y: 10 });
    expect(engine.view().fields[0]).toMatchObject({ id: "distance", value: 10 });
    engine.submitText("4");
    expect(engine.isActive()).toBe(false);
    expect(lines(log.project)[0].a.y).toBeCloseTo(4, 9);
  });

  it("Kopie (I): Original bleibt; der Modus übersteht Esc (ein Schritt zurück)", () => {
    const { engine, log } = setup();
    engine.start("move");
    engine.pick({ x: 0, y: 0 });
    engine.chooseOption("copy");
    expect(engine.stepDepth()).toBe(1);
    engine.escape(1000);
    expect(engine.stepDepth()).toBe(0);
    expect(engine.view().options.find((o) => o.active)?.id).toBe("copy");
    engine.pick({ x: 0, y: 0 });
    engine.pick({ x: 0, y: 5 });
    expect(lines(log.project)).toHaveLength(2);
  });

  it("N Kopien (O) mit Anzahl aus dem Dialog", () => {
    const { engine, log } = setup();
    engine.start("move");
    engine.chooseOption("array", 3);
    expect(engine.view().options.find((o) => o.id === "array")?.value).toBe("×3");
    engine.pick({ x: 0, y: 0 });
    engine.pick({ x: 0, y: 1 });
    expect(lines(log.project)).toHaveLength(4);
  });

  it("Drehen: Zentrum → Bezug → getippter Winkel ab der Bezugsrichtung", () => {
    const { engine, log } = setup();
    engine.start("rotate");
    engine.pick({ x: 0, y: 0 });
    engine.pick({ x: 1, y: 0 });
    expect(engine.view().promptKey).toBe("transform.hint.rotate.2");
    engine.move({ x: 0, y: 1 });
    expect(engine.view().fields[0].value).toBeCloseTo(90, 9);
    engine.submitText("90");
    const g = lines(log.project)[0];
    expect(g.b.x).toBeCloseTo(0, 9);
    expect(g.b.y).toBeCloseTo(2, 9);
  });

  it("Spiegeln: Enter setzt den Punkt an der letzten Mausposition", () => {
    const { engine, log } = setup();
    engine.start("mirror");
    engine.pick({ x: 0, y: 1 });
    engine.move({ x: 1, y: 1 });
    engine.confirm();
    expect(engine.isActive()).toBe(false);
    const g = lines(log.project)[0];
    expect(g.a.y).toBeCloseTo(2, 9);
    expect(g.b.y).toBeCloseTo(2, 9);
    expect(lines(log.project)).toHaveLength(1);
  });

  it("Esc-Esc schnell bricht ab, nichts committet", () => {
    const { engine, log } = setup();
    engine.start("rotate");
    engine.pick({ x: 0, y: 0 });
    engine.pick({ x: 1, y: 0 });
    engine.escape(5000);
    engine.escape(5000 + ESC_DOUBLE_MS - 50);
    expect(engine.isActive()).toBe(false);
    expect(lines(log.project)[0].b).toEqual({ x: 2, y: 0 });
  });
});
