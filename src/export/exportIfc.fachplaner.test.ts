// [259] IFC-Export für Fachplaner (Vorprojekt): alle drei Beispielprojekte gegen ifcopenshell — Schema/Express-Regeln/
// Geometrie (`scripts/validate-ifc.py`) und die inhaltliche Prüfung `scripts/check-ifc-fachplaner.py` (räumliche
// Struktur, jedes Bauteil genau einmal eingeordnet, Georeferenz lokal + IfcMapConversion EPSG:2056, Öffnungen gefüllt
// und im Geschoss des Wirts, Räume mit Mengen/SIA-416-Kategorie, Wandschichten, Mengen ±1 % gegen die Geometrie,
// Geschoss-GF mit Konstruktionsfläche, Kontext nur mit Option, keine 2D-Objektbibliothek als 3D-Körper).
// Ohne Python/ifcopenshell übersprungen (CI installiert es).

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../engine/fileioWasm.setup";
import { exportIfcSpf, type IfcExportOptions } from "./exportIfc";
import { sampleProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { buildWettbewerbSampleProject } from "../model/sampleProjectWettbewerb";
import type { Drawing2D, Project } from "../model/types";

const hasIfcOpenShell = spawnSync("python3", ["-c", "import ifcopenshell, ifcopenshell.validate, ifcopenshell.util.shape, _pytest"]).status === 0;

function writeIfc(name: string, ifc: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "dossier-ifc-fp-")), `${name}.ifc`);
  writeFileSync(file, ifc);
  return file;
}

interface Check {
  problems: string[];
  stats: Record<string, unknown> & { counts: Record<string, number>; context: number; far: number; known: string[]; map?: number[]; storeyQto?: Record<string, Record<string, number>> };
}

/** Beide Prüfskripte; liefert die Kennwerte der inhaltlichen Prüfung. */
function check(name: string, ifc: string, flags: string[]): Check {
  const file = writeIfc(name, ifc);
  const v = spawnSync("python3", ["scripts/validate-ifc.py", file], { encoding: "utf8", timeout: 400_000 });
  expect(`${v.stdout}\n${v.stderr}`).toContain(" 0 Befunde");
  const r = spawnSync("python3", ["scripts/check-ifc-fachplaner.py", file, "--json", ...flags], { encoding: "utf8", timeout: 400_000 });
  expect(r.stdout, r.stderr).not.toBe("");
  const out = JSON.parse(r.stdout) as Check;
  expect(out.problems).toEqual([]);
  expect(r.status).toBe(0);
  return out;
}

/** Export mit festem Zeitstempel (Vergleich zweier Dateien). */
function exportAt(p: Project, options: IfcExportOptions = {}): string {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
  try {
    return exportIfcSpf(p, options);
  } finally {
    vi.useRealTimers();
  }
}

describe.skipIf(!hasIfcOpenShell)("[259] IFC für Fachplaner (ifcopenshell)", { timeout: 900_000 }, () => {
  it("Musterhaus: Struktur, Mengen, Öffnungen", () => {
    const c = check("musterhaus", exportIfcSpf(sampleProject), []);
    expect(c.stats.counts.IfcWall).toBe(sampleProject.walls.length);
    expect(c.stats.context).toBe(0);
  });

  it("Wettbewerb: georeferenziert (lokal + IfcMapConversion, ±0.00 = 441.30), Geschoss-GF mit Konstruktionsfläche", () => {
    const p = buildWettbewerbSampleProject();
    const c = check("wettbewerb", exportIfcSpf(p), ["--geo"]);
    expect(c.stats.far).toBeLessThan(1000);
    expect(c.stats.map).toEqual([p.geoAnchor!.lv95.e - p.geoAnchor!.model.x, p.geoAnchor!.lv95.n - p.geoAnchor!.model.y, 441.3]);
    const eg = c.stats.storeyQto!.Erdgeschoss;
    expect(eg.GrossFloorArea).toBeGreaterThan(eg.NetFloorArea);
    expect(c.stats.spaces).toBe(p.rooms!.length);
  });

  it("Wettbewerb mit Kontext: Nachbargebäude am IfcSite, sonst nichts geändert", () => {
    const p = buildWettbewerbSampleProject();
    const c = check("wettbewerb-kontext", exportIfcSpf(p, { context: true }), ["--geo", "--context"]);
    expect(c.stats.context).toBe(p.context!.filter((o) => o.type === "importedMesh").length);
  });

  it("komplex: Bogenkanten (Erker) mit Fläche/Volumen = Mengen, Kontext (Gelände + Nachbar) mit Option", () => {
    const p = buildComplexSampleProject();
    // [259] Anbauwand OG Ost unter dem Pultdach (Stücke um das Fenster mit je eigener Dach-Oberkante): als 3D-Körper
    // (vereinigt) statt verschweisster Schalen — ifcopenshell zieht die Öffnung richtig ab (vorher 30.4 statt 7.5 m³).
    const k = check("komplex", exportIfcSpf(p), ["--geo"]);
    expect(k.stats.known).toEqual([]);
    const c = check("komplex-kontext", exportIfcSpf(p, { context: true }), ["--geo", "--context"]);
    expect(c.stats.counts.IfcGeographicElement).toBeGreaterThanOrEqual(1); // Gelände (TERRAIN)
    expect(c.stats.context).toBe(2); // Gelände + Nachbargebäude; Höhenlinien und Baugrube nicht
  });
});

describe("[259] 2D-Objektbibliothek im IFC", () => {
  it("bleibt draussen: die Datei ist mit und ohne Objekte zeichengleich", () => {
    const objs: Drawing2D[] = [
      { id: "wc", type: "drawing2d", levelId: "eg", categoryCode: "23", geom: { shape: "libobj", libId: "lib:wc-wand", at: { x: 1, y: 1 }, rotation: 0 } },
      { id: "ti", type: "drawing2d", levelId: "eg", categoryCode: "22", geom: { shape: "libobj", libId: "lib:tisch-80x140", at: { x: 3, y: 2 }, rotation: 0.5, seed: 3 } },
    ];
    const without = exportAt(sampleProject);
    const withObjs = exportAt({ ...sampleProject, drawings2d: [...sampleProject.drawings2d, ...objs] });
    expect(withObjs).toBe(without);
    expect(withObjs).not.toMatch(/IFCFURNITURE|IFCSANITARYTERMINAL|IFCFURNISHINGELEMENT/);
  });
});
