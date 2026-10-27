import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { parseProjectFile, PROJECT_FORMAT_VERSION, serializeProject } from "./projectFormat";

describe("Projektdatei-Format", () => {
  it("Speichern setzt die Formatversion, Laden liefert dasselbe Projekt zurueck", () => {
    const text = serializeProject(sampleProject);
    expect(JSON.parse(text).formatVersion).toBe(PROJECT_FORMAT_VERSION);
    const r = parseProjectFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.project.walls).toEqual(sampleProject.walls);
  });
  it("alte Datei ohne Version wird migriert", () => {
    const r = parseProjectFile(JSON.stringify(sampleProject));
    expect(r.ok && r.migratedFrom).toBe(0);
    expect(r.ok && r.project.formatVersion).toBe(PROJECT_FORMAT_VERSION);
  });
  it("neuere Datei wird mit Meldung abgelehnt", () => {
    const r = parseProjectFile(JSON.stringify({ ...sampleProject, formatVersion: PROJECT_FORMAT_VERSION + 1 }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/neueren Dossier-Version/);
  });
  it("kein JSON, kein Objekt, fehlende Pflichtlisten: Fehler mit Meldung", () => {
    expect(parseProjectFile("{kaputt").ok).toBe(false);
    expect(parseProjectFile("[1,2]").ok).toBe(false);
    const { walls: _w, ...noWalls } = sampleProject;
    const r = parseProjectFile(JSON.stringify(noWalls));
    expect(!r.ok && r.error).toMatch(/walls/);
  });
  it("tolerant: fehlende Listen ergaenzt, falsche Typen geleert, unbekannte Felder gemeldet und behalten", () => {
    const { doors: _d, ...rest } = sampleProject;
    const r = parseProjectFile(JSON.stringify({ ...rest, hatches: "x", zukunft: 1 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.doors).toEqual([]);
    expect(r.project.hatches).toEqual([]);
    expect((r.project as unknown as { zukunft: number }).zukunft).toBe(1);
    expect(r.warnings.join(" ")).toMatch(/hatches/);
    expect(r.warnings.join(" ")).toMatch(/zukunft/);
  });
  it("ungueltige Versionsangabe ist ein Fehler", () => {
    expect(parseProjectFile(JSON.stringify({ ...sampleProject, formatVersion: "1" })).ok).toBe(false);
  });
});
