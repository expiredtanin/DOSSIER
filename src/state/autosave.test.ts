import { describe, expect, it } from "vitest";
import { createAutosaveTracker } from "./autosave";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

const edit = (p: Project, name: string): Project => ({ ...p, name });
const empty = { ...sampleProject, walls: [], drawings2d: [], openings: [], ceilings: [], roofs: [], stairs: [], rooms: [], columns: [], extrudedSolids: [], context: [] } as Project;

describe("Autosave-Entscheidung", () => {
  it("schreibt nur ungespeicherte, noch nicht gesicherte Stände mit Inhalt", () => {
    const tr = createAutosaveTracker();
    const saved = sampleProject;
    expect(tr.shouldWrite(saved, saved)).toBe(false);
    const a = edit(saved, "A");
    expect(tr.shouldWrite(a, saved)).toBe(true);
    expect(tr.shouldWrite(a, saved)).toBe(false); // schon gesichert
    expect(tr.shouldWrite(empty, saved)).toBe(false);
  });
  it("nach dem Löschen der Kopie wird derselbe ungespeicherte Stand wieder gesichert", () => {
    // Ablauf: Speichern beginnt mit Stand S, währenddessen Änderung A (vom Autosave gesichert),
    // Speichern endet → Kopie gelöscht, gespeichert ist aber nur S. A muss wieder gesichert werden.
    const tr = createAutosaveTracker();
    const s = edit(sampleProject, "S");
    const a = edit(s, "A");
    expect(tr.shouldWrite(a, sampleProject)).toBe(true);
    tr.cleared();
    expect(tr.shouldWrite(a, s)).toBe(true);
  });
});
