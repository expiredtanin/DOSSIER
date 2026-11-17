// [271] Befehl „Umbau-Status setzen …“: Optionen B/A/N, Mehrfachauswahl in einem Schritt, ohne Auswahl kein Start.

import { describe, expect, it } from "vitest";
import { renovationCommand, renovationSelectionIds } from "./renovation";
import type { CommandContext } from "../types";
import { sampleProject } from "../../model/sampleProject";
import { applyOps } from "../../core/ops";

function ctx(sel: Partial<CommandContext["selection"]>): CommandContext {
  return {
    project: sampleProject,
    level: sampleProject.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null, ...sel },
  };
}

describe("[271] renovation", () => {
  it("ohne Auswahl: Hinweis statt Start", () => {
    expect(renovationCommand.precondition?.(ctx({}))).toBe("cmd.renovation.needsSelection");
    expect(renovationCommand.precondition?.(ctx({ wallIds: ["W1"] }))).toBeNull();
  });

  it("Option „Abbruch“ setzt den Status aller gewählten Bauteile in einem Schritt", () => {
    const c = ctx({ wallIds: ["W9"], openingIds: ["O2"], ceilingIds: ["C1"] });
    expect(renovationSelectionIds(c.selection)).toEqual(["W9", "O2", "C1"]);
    expect(renovationCommand.options(renovationCommand.init()).map((o) => o.id)).toEqual(["existing", "demolish", "new"]);
    const [, res] = renovationCommand.onInput(renovationCommand.init(), { kind: "option", id: "demolish" }, c);
    expect(res.done).toBe(true);
    const ops = res.commit!.toOps(sampleProject);
    expect(ops).toHaveLength(3);
    const p = applyOps(sampleProject, ops);
    expect(p.walls.find((w) => w.id === "W9")?.renovation?.status).toBe("demolish");
    expect(p.openings?.find((o) => o.id === "O2")?.renovation?.status).toBe("demolish");
  });

  it("getippt: Kürzel N; Unsinn bleibt im Schritt", () => {
    const c = ctx({ wallIds: ["W1"] });
    const [, bad] = renovationCommand.onInput(renovationCommand.init(), { kind: "text", text: "xyz" }, c);
    expect(bad.done).toBeFalsy();
    const [, res] = renovationCommand.onInput(renovationCommand.init(), { kind: "text", text: "n" }, c);
    const p = applyOps(sampleProject, res.commit!.toOps(sampleProject));
    expect(p.walls.find((w) => w.id === "W1")?.renovation).toEqual({ status: "new" });
  });
});
