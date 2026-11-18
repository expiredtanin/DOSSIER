// [285] Fenster-Befehl: eine getippte Zahl beim Schritt „Position entlang der Wand (Abstand tippen)“ ist der
// ABSTAND vom Wandanfang, nicht die Breite (vorher setzte sie still die Breite: „3“ = 3 m breites Fenster).
import { describe, expect, it } from "vitest";
import { CommandEngine, type EngineHost } from "../engine";
import type { CommandContext } from "../types";
import type { ProjectMutation } from "../../core";
import { sampleProject } from "../../model/sampleProject";

// Beispielhaus ohne die vorhandenen Öffnungen (sonst weicht das Fenster ihnen aus).
const project = { ...sampleProject, openings: [] };
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
      e.pick({ x: 1, y: 0 });
      e.submitText("3.5");
      e.confirm();
    });
    expect(commits).toHaveLength(1);
    const q = commits[0](project);
    const o = (q.openings ?? []).find((x) => !(project.openings ?? []).some((y) => y.id === x.id))!;
    expect(o.hostWallId).toBe("W1");
    expect(o.position).toBeCloseTo(3.5, 6);
    expect(o.width).toBeCloseTo(1.2, 6);
  });
});
