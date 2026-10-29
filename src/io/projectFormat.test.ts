import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { core } from "../engine/coreWasm";
import { parseProjectFile, PROJECT_FORMAT_VERSION, serializeProject } from "./projectFormat";

describe("Projektdatei-Format", () => {
  it("Formatversion in TS und Kern stimmt überein", () => {
    expect(core().project_format_version()).toBe(PROJECT_FORMAT_VERSION);
  });
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

describe("Laden und Speichern im Kern ([K4] S4)", () => {
  // Früher: TS `JSON.parse` → Prüfung/Migration → `JSON.stringify({ formatVersion, ...rest }, null, 2)`.
  // Heute liest, migriert und schreibt der Kern; die Datei muss Zeichen für Zeichen gleich bleiben
  // (Zahlen wie JS `String(n)`, Index-Schlüssel wie ein JS-Objekt vorn).
  const reference = (p: object): string => JSON.stringify({ formatVersion: PROJECT_FORMAT_VERSION, ...p }, null, 2);
  const TRICKY = [0.000005, 1.5e-7, 1e21, 2 ** 60, 2 ** 53 + 2, -0, 0.1 + 0.2, 1e16, 2.7755575615628914e-17, -1e-6];

  it("Speichern nach Öffnen = JSON.stringify der Leseansicht (Beispiel, knifflige Zahlen, Index-Schlüssel)", () => {
    const odd = {
      ...structuredClone(sampleProject),
      walls: sampleProject.walls.map((w, i) => ({ ...w, height: TRICKY[i % TRICKY.length] })),
      zukunft: { b: 1, "21": "x\u0001\n😀", "10": [1.0, 2.5e-7], "007": null, "4294967295": 0 },
    };
    const texts = [JSON.stringify(sampleProject), JSON.stringify(odd), JSON.stringify(odd, null, 2).replace(/: 2,/g, ": 2.0,")];
    for (const text of texts) {
      const r = parseProjectFile(text);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const saved = serializeProject(r.project);
      expect(saved).toBe(reference(r.project));
      const { formatVersion: _v, ...raw } = JSON.parse(text) as Record<string, unknown>;
      expect(saved).toBe(reference(raw));
    }
  });

  it("Index-Schlüssel stehen vorn, aufsteigend (wie JSON.parse in JS)", () => {
    const text = `{"walls":[],"layers":[],"drawingLevels":[],"m":{"x":1,"10":2,"2":3,"01":4}}`;
    const r = parseProjectFile(text);
    expect(r.ok && Object.keys((r.project as unknown as { m: object }).m)).toEqual(["2", "10", "x", "01"]);
    expect(r.ok && serializeProject(r.project)).toBe(r.ok && reference(r.project));
  });

  it("migrierte Datei wird im neuen Format gespeichert", () => {
    const old = { ...structuredClone(sampleProject), formatVersion: 1, doors: [{ id: "TX", hostWallId: "W1", position: 0.5, width: 0.9, height: 2.1 }] };
    const r = parseProjectFile(JSON.stringify(old));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const saved = serializeProject(r.project);
    expect(saved).toBe(reference(r.project));
    expect(JSON.parse(saved).doors).toBeUndefined();
    const again = parseProjectFile(saved);
    expect(again.ok && again.migratedFrom).toBeNull();
    expect(again.ok && serializeProject(again.project)).toBe(saved);
  });
});
