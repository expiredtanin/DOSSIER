// [99] Esc/Enter in JEDEM Befehl gleich: Esc = ein Schritt zurück (ohne Schritt: Befehl endet),
// Esc-Esc schnell (≤ ESC_DOUBLE_MS) = ganzer Befehl abbrechen (nichts aus dem offenen Teil
// committet), Enter = abschliessen. Geprüft an der Engine mit einem Test-Host.
import { describe, expect, it } from "vitest";
import { COMMANDS } from "./registry";
import { CommandEngine, ESC_DOUBLE_MS, type EngineHost } from "./engine";
import type { CommandContext } from "./types";
import type { ToolDraft } from "../tools/types";
import { sampleProject } from "../model/sampleProject";

const level = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
const ctx: CommandContext = {
  project: sampleProject,
  level,
  defaultCategoryCode: sampleProject.layers[0]?.code ?? "20",
  activeLineStyleId: "",
  activeWallTypeId: sampleProject.wallTypes[0]?.id ?? "",
  lastPoint: null,
  selection: { wallIds: [], drawingId: null, drawingIds: [] } as unknown as CommandContext["selection"],
};

function setup() {
  const log = { commits: 0, draft: null as ToolDraft | null };
  const host: EngineHost = {
    context: (lastPoint) => ({ ...ctx, lastPoint }),
    snap: () => null,
    pxPerMeter: () => 50,
    setDraft: (d) => (log.draft = d),
    commit: () => void log.commits++,
    isFloor: () => true,
  };
  return { engine: new CommandEngine(host), log };
}

const P = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 4 },
  { x: 1, y: 6 },
];

describe("[263] Unbekannter Befehl im Ruhezustand", () => {
  it("meldet „cmd.unknown“ statt still nichts zu tun; bekannte Befehle melden nichts", () => {
    const notes: { key: string; params?: Record<string, string | number> }[] = [];
    const host: EngineHost = {
      context: (lastPoint) => ({ ...ctx, lastPoint }),
      snap: () => null,
      pxPerMeter: () => 50,
      setDraft: () => {},
      commit: () => {},
      isFloor: () => true,
      notify: (key, params) => void notes.push({ key, params }),
    };
    const engine = new CommandEngine(host);
    engine.submitText("xyzabc");
    expect(notes).toEqual([{ key: "cmd.unknown", params: { name: "xyzabc" } }]);
    expect(engine.isActive()).toBe(false);
    notes.length = 0;
    engine.submitText("polyline");
    expect(notes).toEqual([]);
    expect(engine.isActive()).toBe(true);
  });
});

describe("[287] Wand: Länge tippen", () => {
  it("Länge + Enter legt das Segment sofort in Mausrichtung an (Winkel klar), ohne zweites Enter", () => {
    const { engine, log } = setup();
    engine.start("wall");
    engine.pick({ x: 0, y: 0 });
    engine.move({ x: 0, y: 3 }); // Maus nach +y
    engine.submitText("2");
    expect(engine.stepDepth()).toBe(2);
    engine.confirm(); // zweites Enter beendet den Zug
    expect(log.commits).toBe(1);
  });

  it("Länge + Tab sperrt nur die Länge: Winkel kann zusätzlich getippt werden", () => {
    const { engine } = setup();
    engine.start("wall");
    engine.pick({ x: 0, y: 0 });
    engine.move({ x: 0, y: 3 });
    engine.submitText("2", true);
    expect(engine.stepDepth()).toBe(1); // noch kein zweiter Punkt
    expect(engine.view().fields.find((f) => f.id === "angle")?.active).toBe(true);
  });

  it("Vorschau folgt dem getippten Winkel sofort", () => {
    const { engine, log } = setup();
    engine.start("wall");
    engine.pick({ x: 0, y: 0 });
    engine.move({ x: 3, y: 0 });
    engine.submitText("2", true); // Länge gesperrt, Winkelfeld aktiv
    engine.previewTyped("90");
    const v = log.draft?.hud;
    expect(v).toBeTruthy();
    expect(log.draft!.preview.length).toBeGreaterThan(0);
  });
});

describe("Esc/Enter der Befehls-Engine", () => {
  // [287] löst die Vorgabe [99] für die Wand ab: Esc beendet den offenen Zug und BEHÄLT die Wände.
  it("Wand: Esc beendet den offenen Zug und behält die gezeichneten Wände, zweites Esc ändert nichts mehr", () => {
    const { engine, log } = setup();
    engine.start("wall");
    for (const p of P.slice(0, 3)) engine.pick(p);
    engine.move({ x: 2, y: 2 });
    engine.escape(1000);
    expect(engine.isActive()).toBe(false);
    expect(log.commits).toBe(1);
    expect(log.draft).toBe(null);
    engine.escape(1000 + ESC_DOUBLE_MS + 50);
    expect(engine.isActive()).toBe(false);
    expect(log.commits).toBe(1);
  });

  it("Wand: Esc mit nur dem Startpunkt nimmt ihn zurück, dann endet der Befehl ohne Wand", () => {
    const { engine, log } = setup();
    engine.start("wall");
    engine.pick(P[0]);
    engine.escape(1000);
    engine.escape(1000 + ESC_DOUBLE_MS + 50);
    expect(engine.isActive()).toBe(false);
    expect(log.commits).toBe(0);
  });

  it("Esc ohne Schritt beendet den Befehl", () => {
    const { engine } = setup();
    engine.start("polyline");
    engine.escape(0);
    expect(engine.isActive()).toBe(false);
  });

  it("Esc-Esc schnell bricht den ganzen Befehl ab, nichts wird committet", () => {
    const { engine, log } = setup();
    engine.start("polyline");
    for (const p of P) engine.pick(p);
    engine.escape(5000);
    engine.escape(5000 + ESC_DOUBLE_MS - 50);
    expect(engine.isActive()).toBe(false);
    expect(log.commits).toBe(0);
    expect(log.draft).toBe(null);
  });

  it("Esc löst zuerst einen getippten Feldwert (Lock), dann erst Punkte", () => {
    const { engine } = setup();
    engine.start("wall");
    engine.pick(P[0]);
    if (!engine.hasFields()) return;
    engine.submitText("3");
    expect(engine.view().fields.some((f) => f.locked)).toBe(true);
    engine.escape(0);
    expect(engine.view().fields.some((f) => f.locked)).toBe(false);
    expect(engine.stepDepth()).toBe(1);
  });

  // Jeder registrierte interaktive Befehl: Punkte setzen, Esc = genau ein Schritt zurück
  // (bzw. Ende ohne Schritt), Esc-Esc = aus, ohne dass Esc etwas committet.
  for (const name of Object.keys(COMMANDS)) {
    const cmd = COMMANDS[name];
    if (cmd.autoRun || name === "wall") continue; // Wand: eigene Tests oben ([287])
    it(`${name}: Esc einen Schritt zurück, Esc-Esc bricht ab`, () => {
      const { engine, log } = setup();
      if (!engine.start(name)) return;
      for (const p of P.slice(0, 2)) {
        engine.move(p);
        engine.pick(p);
      }
      if (!engine.isActive()) return; // Befehl mit zwei Punkten fertig
      const depth = engine.stepDepth();
      const commits = log.commits;
      engine.escape(10_000);
      if (depth === 0) expect(engine.isActive()).toBe(false);
      else {
        expect(engine.isActive()).toBe(true);
        expect(engine.stepDepth()).toBe(depth - 1);
      }
      engine.escape(10_000 + 100);
      expect(engine.isActive()).toBe(false);
      expect(log.commits).toBe(commits);
    });
  }
});
