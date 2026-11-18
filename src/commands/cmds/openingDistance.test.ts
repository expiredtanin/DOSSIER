// [285] Fenster-Befehl: eine getippte Zahl vor dem Klick auf die Wand ist der
// ABSTAND vom Wandanfang, nicht die Breite (vorher setzte sie still die Breite: „3“ = 3 m breites Fenster).
import { describe, expect, it } from "vitest";
import { CommandEngine, type EngineHost } from "../engine";
import type { CommandContext } from "../types";
import type { ProjectMutation } from "../../core";
import { sampleProject } from "../../model/sampleProject";
import type { Project } from "../../model/types";

// Beispielhaus ohne die vorhandenen Öffnungen (sonst weicht das Fenster ihnen aus).
const project: Project = { ...sampleProject, openings: [] };
const level = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
const ctx: CommandContext = {
  project,
  level,
  defaultCategoryCode: "20",
  activeLineStyleId: "",
  activeWallTypeId: sampleProject.wallTypes[0]?.id ?? "",
  lastPoint: null,
  selection: { wallIds: [], drawingId: null, drawingIds: [] } as unknown as CommandContext["selection"],
};

function run(type: (e: CommandEngine) => void) {
  const commits: ProjectMutation[] = [];
  const host: EngineHost = {
    context: (lastPoint) => ({ ...ctx, lastPoint }),
    snap: () => null,
    pxPerMeter: () => 50,
    setDraft: () => {},
    commit: (m) => void commits.push(m),
    isFloor: () => true,
  };
  const engine = new CommandEngine(host);
  engine.start("fenster");
  type(engine);
  return commits;
}

describe("Fenster: getippter Abstand", () => {
  it("„3.5“ + Enter setzt das Fenster 3.5 m vom Wandanfang (Breite bleibt 1.2 m)", () => {
    // W1 läuft von (0,0) nach (5,0).
    const commits = run((e) => {
      e.submitText("3.5");
      e.pick({ x: 1, y: 0 });
    });
    expect(commits).toHaveLength(1);
    const q = commits[0](project);
    const o = (q.openings ?? []).find((x) => !(project.openings ?? []).some((y) => y.id === x.id))!;
    expect(o.hostWallId).toBe("W1");
    expect(o.position).toBeCloseTo(3.5, 6);
    expect(o.width).toBeCloseTo(1.2, 6);
  });
});

describe("[287] Fenster: ein Klick auf die Wand", () => {
  it("setzt das Fenster an der Mausposition (Wand aus dem Treffer), Befehl endet", () => {
    let ended = false;
    const commits = run((e) => {
      e.pick({ x: 2.5, y: 0.05 });
      ended = !e.isActive();
    });
    expect(ended).toBe(true);
    expect(commits).toHaveLength(1);
    const q = commits[0](project);
    const o = (q.openings ?? [])[0];
    expect(o.hostWallId).toBe("W1");
    expect(o.position).toBeCloseTo(2.5, 2);
  });

  it("Überfahren der Wand zeigt eine Vorschau mit Abstand-Massen, abseits der Wand keine", () => {
    const drafts: (import("../../tools/types").ToolDraft | null)[] = [];
    const host: EngineHost = {
      context: (lastPoint) => ({ ...ctx, lastPoint }),
      snap: () => null,
      pxPerMeter: () => 50,
      setDraft: (d) => void drafts.push(d),
      commit: () => {},
      isFloor: () => true,
    };
    const engine = new CommandEngine(host);
    engine.start("fenster");
    engine.move({ x: 2.5, y: 0.05 });
    const d = drafts[drafts.length - 1];
    expect(d?.preview.length).toBeGreaterThan(0);
    expect(d?.hud?.text).toMatch(/m · .* · \d+\.\d\d m$/);
    engine.move({ x: 2.5, y: 40 });
    expect(drafts[drafts.length - 1]?.preview ?? []).toHaveLength(0);
  });
});
