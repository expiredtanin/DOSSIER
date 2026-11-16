// [267] Befehl `ansichten`: Ansichten Nord/Ost/Süd/West um das Gebäude in einem Schritt. Geometrie (Hauptrichtung,
// gedrehtes Haus, L-Form) prüft der Kern (`elevation_set.rs`); hier der Weg über Befehl, Meldung und Ops.

import { describe, expect, it } from "vitest";
import { elevationsCommand } from "./elevations";
import { emptyProject, sampleProject } from "../../model/sampleProject";
import type { Project } from "../../model/types";
import type { CommandContext } from "../types";
import { applyOps } from "../../core/ops";
import { getCommand } from "../registry";

const ctxOf = (p: Project) => ({ project: p, level: { id: "eg", kind: "floor" }, defaultCategoryCode: "20", activeWallTypeId: "", selection: { wallIds: [], drawingId: null } }) as unknown as CommandContext;

const run = (p: Project) => elevationsCommand.autoRun!(ctxOf(p));
const apply = (p: Project) => {
  const res = run(p);
  return { res, project: res.commit ? applyOps(p, res.commit.toOps(p)) : p };
};
const elevations = (p: Project) => p.drawingLevels.filter((l) => l.kind === "elevation");

describe("ansichten", () => {
  it("ist als Befehl und Alias registriert", () => {
    expect(getCommand("ansichten")).toBe(elevationsCommand);
  });

  it("Musterhaus: legt Nord, Ost, West an; die vorhandene Süd-Ansicht bleibt", () => {
    const before = elevations(sampleProject);
    expect(before.map((l) => l.name)).toEqual(["Ansicht Süd"]);
    const { res, project } = apply(sampleProject);
    expect(res.done).toBe(true);
    expect(res.notice?.key).toBe("elevations.doneSkipped");
    expect(res.notice?.params).toMatchObject({ n: 3 });
    const names = elevations(project).map((l) => l.name);
    expect(names).toEqual(["Ansicht Süd", "Ansicht Nord", "Ansicht Ost", "Ansicht West"]);
    for (const l of elevations(project)) {
      expect(l.linePoints).toHaveLength(2);
      expect(l.directionSign).toBe(1);
    }
    // Nord blickt nach −y (Linie nördlich des Hauses, von rechts nach links), Ost nach −x.
    const nord = elevations(project).find((l) => l.name === "Ansicht Nord")!.linePoints!;
    expect(nord[1].x).toBeLessThan(nord[0].x);
    expect(nord[0].y).toBeGreaterThan(4);
  });

  it("zweiter Lauf: nichts mehr zu tun, keine Änderung", () => {
    const { project } = apply(sampleProject);
    const again = apply(project);
    expect(again.res.commit).toBeUndefined();
    expect(again.res.notice?.key).toBe("elevations.allExist");
    expect(elevations(again.project)).toHaveLength(4);
  });

  it("leeres Projekt: Meldung, keine Ebenen", () => {
    const { res, project } = apply(emptyProject);
    expect(res.commit).toBeUndefined();
    expect(res.notice).toMatchObject({ key: "elevations.empty", kind: "warning" });
    expect(elevations(project)).toHaveLength(elevations(emptyProject).length);
  });
});
