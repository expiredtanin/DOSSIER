// Datensicherheit ([116], [258]): jedes Beispielprojekt und jede Robustheits-Fixture geht über den normalen
// Öffnen-Pfad (Kern-Lader: Version, Migration, Toleranz) und überlebt Speichern → Öffnen → Speichern ohne
// Verlust, auch die jüngsten Felder (Objektbibliothek, Klassen-Füllung, Wettbewerbs-Kennungen, Baurecht-Vorgaben).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyProject, sampleProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { buildWettbewerbSampleProject } from "../model/sampleProjectWettbewerb";
import { buildBigSampleProject } from "../model/sampleProjectBig";
import { libobjCommand, resetLibObjectPlacement, setActiveLibObject } from "../commands/cmds/libobj";
import { libDefaultParams, libObjectDef } from "../model/furnitureLib";
import type { CommandContext } from "../commands/types";
import type { Project } from "../model/types";
import { parseProjectFile, serializeProject } from "./projectFormat";

/** Öffnen → Speichern → Öffnen → Speichern: Projekt gleich, Datei Zeichen für Zeichen gleich, keine Hinweise. */
function roundtrip(label: string, source: string): Project {
  const first = parseProjectFile(source);
  if (!first.ok) throw new Error(`${label}: Öffnen fehlgeschlagen: ${first.error}`);
  const saved = serializeProject(first.project);
  const second = parseProjectFile(saved);
  if (!second.ok) throw new Error(`${label}: erneutes Öffnen fehlgeschlagen: ${second.error}`);
  expect(second.warnings, `${label}: Hinweise beim erneuten Öffnen`).toEqual([]);
  expect(second.migratedFrom, `${label}: gespeicherte Datei braucht keine Migration`).toBeNull();
  expect(second.project, `${label}: Projekt nach Rundreise`).toEqual(first.project);
  expect(serializeProject(second.project), `${label}: Datei nach zweitem Speichern`).toBe(saved);
  return second.project;
}

describe("Rundreise: Beispielprojekte", () => {
  const samples: [string, () => Project][] = [
    ["leeres Projekt", () => emptyProject],
    ["Musterhaus", () => sampleProject],
    ["Musterhaus komplex", () => buildComplexSampleProject()],
    ["Wettbewerb", () => buildWettbewerbSampleProject()],
    ["Grossgebäude (klein)", () => buildBigSampleProject({ floors: 3, apartments: 4 })],
  ];
  for (const [name, build] of samples) {
    it(name, () => {
      const p = build();
      const out = roundtrip(name, JSON.stringify(p));
      // Bewusst nicht leer: der Rundlauf darf nichts verlieren.
      expect(out.walls.length).toBe(p.walls.length);
      expect(out.drawings2d.length).toBe(p.drawings2d.length);
      expect(out.rooms?.length ?? 0).toBe(p.rooms?.length ?? 0);
    });
  }
});

describe("Rundreise: Robustheits-Fixtures ([258])", () => {
  const dir = join(__dirname, "../../src-tauri/core/tests/fixtures/robust");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("Fixtures sind vorhanden", () => expect(files.length).toBeGreaterThanOrEqual(4));
  for (const f of files) {
    it(f, () => {
      const out = roundtrip(f, readFileSync(join(dir, f), "utf8"));
      expect(out.walls.length).toBeGreaterThan(0);
    });
  }
});

describe("Rundreise: neue Felder (14.11.)", () => {
  const ctx = (p: Project): CommandContext => ({
    project: p,
    level: p.drawingLevels[0],
    defaultCategoryCode: "20",
    activeLineStyleId: "solid",
    activeWallTypeId: p.wallTypes[0]?.id ?? "aw",
    lastPoint: null,
    selection: { wallIds: [], drawingId: null },
  });

  it("Libobj (mit Parametern und Seed), Klassen-Füllung, Wettbewerb-Kennungen, Baurecht-Vorgaben", () => {
    resetLibObjectPlacement();
    let p = buildWettbewerbSampleProject();
    setActiveLibObject("lib:tisch-80x140", { ...libDefaultParams(libObjectDef("lib:tisch-80x140")!), n: 6 });
    const [, r] = libobjCommand.onInput(libobjCommand.init(), { kind: "point", point: { x: 3, y: 4 } }, ctx(p));
    expect(r.commit).toBeDefined();
    p = r.commit!(p);
    const lib = p.drawings2d.find((d) => d.geom.shape === "libobj");
    expect(lib).toBeDefined();

    p = {
      ...p,
      layers: p.layers.map((l, i) => (i === 0 ? { ...l, fill: "#c8c8c8" } : l)),
      competition: { anonymous: true, keyword: "FALKE 7", identifiers: "Muster AG; Anna Beispiel\nmuster@example.ch" },
      siteRules: { ...p.siteRules!, maxGfz: 0.9, maxAz: 0.75, maxBmz: 2.8, maxUz: 0.4, minGz: 0.2, maxFacadeHeight: 11.5, maxHeight: 14 },
    };

    const out = roundtrip("neue Felder", JSON.stringify(p));
    const libOut = out.drawings2d.find((d) => d.geom.shape === "libobj")!;
    expect(libOut.geom).toEqual(lib!.geom);
    expect(out.layers[0].fill).toBe("#c8c8c8");
    expect(out.competition).toEqual({ anonymous: true, keyword: "FALKE 7", identifiers: "Muster AG; Anna Beispiel\nmuster@example.ch" });
    expect(out.siteRules).toMatchObject({ maxGfz: 0.9, maxAz: 0.75, maxBmz: 2.8, maxUz: 0.4, minGz: 0.2, maxFacadeHeight: 11.5, maxHeight: 14 });
  });
});

describe("Öffnen kaputter Dateien: Fehlermeldung statt Absturz, kein Zustand verändert", () => {
  const good = JSON.stringify(sampleProject);
  const cases: [string, string][] = [
    ["leer", ""],
    ["abgeschnitten (Absturz mitten im Schreiben)", good.slice(0, good.length >> 1)],
    ["nur Anfang", "{"],
    ["Binärmüll", "\u0000\u0001\u0002��"],
    ["Array statt Objekt", "[1,2,3]"],
    ["null", "null"],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      const r = parseProjectFile(text);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.length).toBeGreaterThan(0);
    });
  }
  it("danach lädt eine gute Datei wieder (kein hängengebliebener Zustand)", () => {
    expect(parseProjectFile(good.slice(0, 200)).ok).toBe(false);
    expect(parseProjectFile(good).ok).toBe(true);
  });
});
