// [272] Befehle „Variante zuweisen …“ und „In Variante kopieren …“: Ziel als Satz=Variante, Name, Nummer oder H, ein Schritt.

import { describe, expect, it } from "vitest";
import { designOptionCommand, designOptionCopyCommand, designOptionSelectionIds, parseDesignOptionTarget } from "./designOption";
import type { CommandContext } from "../types";
import { sampleProject } from "../../model/sampleProject";
import { buildVariantenSampleProject } from "../../model/sampleProjectVarianten";
import { applyOps } from "../../core/ops";
import { withDocument } from "../../core/document";
import type { Project } from "../../model/types";

function ctx(project: Project, sel: Partial<CommandContext["selection"]>): CommandContext {
  return {
    project,
    level: project.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null, ...sel },
  };
}

describe("[272] variante", () => {
  it("ohne Satz oder ohne Auswahl: Hinweis statt Start", () => {
    expect(designOptionCommand.precondition?.(ctx(sampleProject, { wallIds: ["W1"] }))).toBe("cmd.designOption.needsSet");
    const p = buildVariantenSampleProject();
    expect(designOptionCommand.precondition?.(ctx(p, {}))).toBe("cmd.designOption.needsSelection");
    expect(designOptionCommand.precondition?.(ctx(p, { wallIds: ["W1"] }))).toBeNull();
  });

  it("Ziel lesen: Satz=Variante, Name, Nummer, H; Unbekanntes/Mehrdeutiges = undefined", () => {
    const p = buildVariantenSampleProject();
    expect(parseDesignOptionTarget(p, "Dachform=B Satteldach")).toEqual({ set: "dachform", option: "b" });
    expect(parseDesignOptionTarget(p, "b bandfenster")).toEqual({ set: "fassade", option: "b" });
    expect(parseDesignOptionTarget(p, "2")).toEqual({ set: "dachform", option: "b" });
    expect(parseDesignOptionTarget(p, "H")).toBeNull();
    expect(parseDesignOptionTarget(p, "a")).toBeUndefined();
    expect(parseDesignOptionTarget(p, "99")).toBeUndefined();
    expect(parseDesignOptionTarget(p, "")).toBeUndefined();
  });

  it("weist alle gewählten Elemente samt 2D in einem Schritt zu; kopiert in eine Variante", () => {
    const p = buildVariantenSampleProject();
    const c = ctx(p, { wallIds: ["W1"], openingIds: ["O1"], drawingIds: [] });
    expect(designOptionSelectionIds(c.selection)).toEqual(["W1", "O1"]);
    const [, res] = designOptionCommand.onInput(designOptionCommand.init(), { kind: "text", text: "Fassade=B Bandfenster" }, c);
    expect(res.done).toBe(true);
    const q = withDocument(p, () => applyOps(p, res.commit!.toOps(p)));
    expect(q.walls.find((w) => w.id === "W1")?.designOption).toEqual({ set: "fassade", option: "b" });
    expect(q.openings?.find((o) => o.id === "O1")?.designOption).toEqual({ set: "fassade", option: "b" });
    // Unbekanntes Ziel: bleibt im Befehl.
    const [, r2] = designOptionCommand.onInput(designOptionCommand.init(), { kind: "text", text: "quatsch" }, c);
    expect(r2.done).toBeFalsy();
    const [, r3] = designOptionCopyCommand.onInput(designOptionCopyCommand.init(), { kind: "option", id: "main" }, c);
    expect(r3.done).toBe(true);
    expect(r3.commit).toBeDefined();
  });
});
