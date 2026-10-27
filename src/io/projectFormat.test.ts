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
    const { lineStyles: _l, ...rest } = sampleProject;
    const r = parseProjectFile(JSON.stringify({ ...rest, hatches: "x", zukunft: 1 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.lineStyles).toEqual([]);
    expect(r.project.hatches).toEqual([]);
    expect((r.project as unknown as { zukunft: number }).zukunft).toBe(1);
    expect(r.warnings.join(" ")).toMatch(/hatches/);
    expect(r.warnings.join(" ")).toMatch(/zukunft/);
  });
  it("ungueltige Versionsangabe ist ein Fehler", () => {
    expect(parseProjectFile(JSON.stringify({ ...sampleProject, formatVersion: "1" })).ok).toBe(false);
  });
});

describe("Migration 1 → 2: Legacy-Türen werden Öffnungen", () => {
  it("doors → openings (kind door), Feld doors entfällt, Kollisions-ids bleiben eindeutig", () => {
    const base = JSON.parse(JSON.stringify(sampleProject)) as Record<string, unknown>;
    const existing = (base.openings as Array<{ id: string }>)[0].id;
    base.formatVersion = 1;
    base.doors = [
      { id: "TX", type: "door", hostWallId: "W1", categoryCode: "21", position: 0.5, width: 0.9, height: 2.1, swing: "right", hinge: "end" },
      { id: existing, type: "door", hostWallId: "W1", categoryCode: "21", position: 3, width: 0.8, height: 2, swing: "left", hinge: "start" },
    ];
    const r = parseProjectFile(JSON.stringify(base));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(1);
    expect("doors" in r.project).toBe(false);
    const ids = (r.project.openings ?? []).map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tx = r.project.openings!.find((o) => o.id === "TX")!;
    expect(tx).toMatchObject({ kind: "door", position: 0.5, width: 0.9, height: 2.1, sillHeight: 0, swing: "right", hinge: "end", type: "opening" });
    expect(r.project.openings!.some((o) => o.id === `${existing}-t` && o.kind === "door")).toBe(true);
  });
});
