// [143] Baugrube erstellen: Voraussetzung Gelände, Anlegen im Musterhaus komplex (Sohle unter dem UG, Kategorie
// „07 Baugrube", sichtbar im Grundriss), Hinweise statt stillem Scheitern, Engine meldet blockierte Befehle.
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../../model/sampleProjectComplex";
import { sampleProject } from "../../model/sampleProject";
import type { Project } from "../../model/types";
import { CommandEngine, type EngineHost } from "../engine";
import type { Command, CommandContext, CommandResult, CmdInput } from "../types";
import { excavationCommand } from "./excavation";
import { terrainCommand } from "./terrain";
import { flattenCategories } from "../../model/layers";

const complex = buildComplexSampleProject();

function ctxOf(p: Project, levelId?: string): CommandContext {
  const level = p.drawingLevels.find((l) => (levelId ? l.id === levelId : l.kind === "floor"))!;
  return {
    project: p,
    level,
    defaultCategoryCode: p.layers[0].code,
    activeLineStyleId: "solid",
    activeWallTypeId: p.wallTypes[0]?.id ?? "",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null, drawingIds: [] } as unknown as CommandContext["selection"],
  };
}

/** Umriss klicken und mit Enter abschliessen; liefert das letzte Ergebnis. */
function draw(cmd: Command, ctx: CommandContext, pts: [number, number][]): CommandResult {
  let st = cmd.init();
  for (const [x, y] of pts) st = cmd.onInput(st, { kind: "point", point: { x, y } } as CmdInput, ctx)[0];
  return cmd.onConfirm(st, ctx)[1];
}

const excavations = (p: Project) => (p.context ?? []).filter((o) => o.type === "excavation");

describe("[143] Baugrube erstellen", () => {
  it("ohne Gelände startet der Befehl nicht (Hinweis)", () => {
    expect(excavationCommand.precondition?.(ctxOf(sampleProject))).toBe("cmd.excavation.noTerrain");
    expect(excavationCommand.precondition?.(ctxOf(complex, "eg"))).toBeNull();
  });

  it("Musterhaus komplex, im EG gezeichnet: Sohle unter dem UG, Kategorie 07, Hinweis", () => {
    const ctx = ctxOf(complex, "eg");
    const res = draw(excavationCommand, ctx, [
      [-25, -10],
      [-12, -10],
      [-12, 0],
      [-25, 0],
    ]);
    expect(res.done).toBe(true);
    expect(res.commit).toBeDefined();
    expect(res.notice?.key).toMatch(/^cmd\.excavation\.(created|fillOnly)$/);
    const out = res.commit!(complex);
    const added = excavations(out).filter((e) => !excavations(complex).some((o) => o.id === e.id));
    expect(added).toHaveLength(1);
    const ug = complex.drawingLevels.find((l) => l.id === "ug")!;
    expect(added[0]).toMatchObject({ categoryCode: "07", bottom: expect.closeTo((ug.baseElevation ?? 0) - 0.3, 6) });
    // Kategorie existiert (im Musterhaus schon vorhanden) und ist sichtbar.
    expect(flattenCategories(out.layers).find((c) => c.code === "07")?.visible).toBe(true);
  });

  it("2 Punkte = Rechteck; ausserhalb des Geländes / entartet: nichts, mit Hinweis", () => {
    const ctx = ctxOf(complex, "eg");
    const rect = draw(excavationCommand, ctx, [
      [-25, -10],
      [-12, 0],
    ]);
    expect(rect.commit).toBeDefined();
    const far = draw(excavationCommand, ctx, [
      [5000, 5000],
      [5010, 5010],
    ]);
    expect(far.commit).toBeUndefined();
    expect(far.notice?.key).toBe("cmd.excavation.outside");
    const flat = draw(excavationCommand, ctx, [
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    expect(flat.commit).toBeUndefined();
    expect(flat.notice?.key).toBe("cmd.excavation.degenerate");
  });

  it("neues Projekt ohne Kategorie 07: der Befehl legt sie sichtbar an", () => {
    const p: Project = {
      ...complex,
      layers: complex.layers.map((l) => ({ ...l, children: l.children?.filter((c) => c.code !== "07") })).filter((l) => l.code !== "07"),
    };
    expect(flattenCategories(p.layers).some((c) => c.code === "07")).toBe(false);
    const res = draw(excavationCommand, ctxOf(p, "eg"), [
      [-25, -10],
      [-12, 0],
    ]);
    const out = res.commit!(p);
    expect(flattenCategories(out.layers).find((c) => c.code === "07")).toMatchObject({ name: "Baugrube", visible: true });
  });

  it("Gelände-Befehl: ohne Höhenlinien sofort fertig mit Hinweis (schluckt keine Eingaben)", () => {
    const res = terrainCommand.autoRun!(ctxOf({ ...sampleProject, context: [] }));
    expect(res.done).toBe(true);
    expect(res.commit).toBeUndefined();
    expect(res.notice?.key).toBe("cmd.terrain.noContours");
  });

  it("Engine: blockierte Befehle melden sich (Voraussetzung, kein Geschoss), Hinweise aus Ergebnissen", () => {
    const notes: string[] = [];
    let floor = true;
    let project: Project = sampleProject;
    const host: EngineHost = {
      context: (lastPoint) => ({ ...ctxOf(project), lastPoint }),
      snap: () => null,
      pxPerMeter: () => 50,
      setDraft: () => {},
      commit: () => {},
      isFloor: () => floor,
      notify: (key) => void notes.push(key),
    };
    const engine = new CommandEngine(host);
    expect(engine.start("baugrube")).toBe(false);
    expect(notes).toEqual(["cmd.excavation.noTerrain"]);
    floor = false;
    expect(engine.start("excavation")).toBe(false);
    expect(notes.at(-1)).toBe("cmd.needsFloor");
    floor = true;
    project = complex;
    expect(engine.start("excavation")).toBe(true);
    for (const pt of [{ x: 5000, y: 5000 }, { x: 5010, y: 5010 }]) engine.pick(pt);
    engine.confirm();
    expect(engine.isActive()).toBe(false);
    expect(notes.at(-1)).toBe("cmd.excavation.outside");
  });
});
