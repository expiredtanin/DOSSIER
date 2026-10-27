// Unit-Tests für projectStore.ts — Guard-Verhalten ohne IndexedDB.
//
// vitest läuft mit environment: "node" (siehe vitest.config.ts); dort
// existiert `indexedDB` nicht, und `fake-indexeddb` ist keine devDependency
// dieses Repos. Getestet wird daher primär, dass die API auch ohne
// IndexedDB sauber degradiert (siehe CONVENTIONS/Auftrag): `loadProject`
// liefert `null`, `listProjects` liefert `[]`, `saveProject`/`deleteProject`
// werfen nicht.

import { describe, it, expect } from "vitest";
import { saveProject, loadProject, listProjects, deleteProject } from "./projectStore";
import type { Project } from "../model/types";

/** Minimalprojekt (analog model/wall.test.ts) — genügt der Project-Form. */
function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [],
    wallTypes: [],
    drawingLevels: [],
    layers: [],
    walls: [],
    ...overrides,
  } as Project;
}

describe("projectStore — Guard ohne IndexedDB", () => {
  it("loadProject liefert null", async () => {
    await expect(loadProject("irgendein-projekt")).resolves.toBeNull();
  });

  it("listProjects liefert leere Liste", async () => {
    await expect(listProjects()).resolves.toEqual([]);
  });

  it("saveProject wirft nicht (no-op)", async () => {
    await expect(saveProject("p1", makeProject())).resolves.toBeUndefined();
  });

  it("deleteProject wirft nicht (no-op)", async () => {
    await expect(deleteProject("p1")).resolves.toBeUndefined();
  });

  it("loadProject mit leerem Namen liefert null, ohne indexedDB zu berühren", async () => {
    await expect(loadProject("")).resolves.toBeNull();
  });

  it("saveProject mit leerem Namen ist ein No-op", async () => {
    await expect(saveProject("", makeProject())).resolves.toBeUndefined();
  });

  it("deleteProject mit leerem Namen ist ein No-op", async () => {
    await expect(deleteProject("")).resolves.toBeUndefined();
  });
});
