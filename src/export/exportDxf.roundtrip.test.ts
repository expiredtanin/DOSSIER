/**
 * DXF-/DWG-Export über Rust/acadrust ([C1]/[C2]) — inhaltliche Rundreise statt Textvergleich.
 *
 * Der frühere TS-Writer wurde gegen festen DXF-Text geprüft; acadrust formatiert anders (volle
 * f64-Genauigkeit statt 6 Nachkommastellen, eigene Handles, mehr Tabellen). Deshalb: exportieren,
 * mit einem UNABHÄNGIGEN Leser zurücklesen (DXF: Gruppen-Code-Leser; DWG: libredwg, wie der
 * DWG-Import) und Ebenen/Entitäten/Koordinaten mit dem vergleichen, was der Plan hineingegeben hat.
 * (acadrusts eigene Rundreise prüft `cargo test` in src-tauri/fileio.)
 */

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { buildPlanDwg, buildPlanDxf, collectPlanDrawing } from "./exportDxf";
import { countByType, libreDwgReader, num, nums, readDxf, str } from "./cadReadBack.testutil";
import { sampleProject } from "../model/sampleProject";
import { generatePlan } from "../plan/generatePlan";
import type { Plan } from "../plan/generatePlan";
import { flattenCategories } from "../model/types";
import type { Project } from "../model/types";
import { projectToWorldCoords } from "../model/geoRebase";

const allCodes = (p: Project) => new Set(flattenCategories(p.layers).map((l) => l.code));

/** Was die flache Zeichnung an Entitäten trägt (Zählung je Typ, aus dem Puffer). */
function flatCounts(plan: Plan, project: Project): Record<string, number> {
  const [flat] = collectPlanDrawing(plan, project).args();
  const names: Record<number, [string, (i: number) => number]> = {
    1: ["", () => 4],
    2: ["LINE", () => 6],
    3: ["LWPOLYLINE", (i) => 4 + 2 * flat[i + 3]],
    4: ["ARC", () => 7],
    5: ["CIRCLE", () => 5],
    6: ["TEXT", () => 7],
  };
  const out: Record<string, number> = {};
  for (let i = 1; i < flat.length; ) {
    const [name, len] = names[flat[i]];
    if (name) out[name] = (out[name] ?? 0) + 1;
    i += len(i);
  }
  return out;
}

describe("DXF-Export (R2018 über acadrust)", () => {
  const plan = generatePlan(sampleProject, "eg", allCodes(sampleProject));

  it("Version R2018, Einheit Meter, alle Kategorie-Ebenen", () => {
    const text = buildPlanDxf(plan, sampleProject);
    const dxf = readDxf(text);
    expect(dxf.version).toBe("AC1032");
    expect(text).toMatch(/\$INSUNITS\r?\n\s*70\r?\n\s*6\r?\n/);
    for (const c of flattenCategories(sampleProject.layers)) {
      const name = `${c.code}_${c.name}`.trim().replace(/[<>/\\":;?*|=`]/g, "_").replace(/\s+/g, "_");
      const layer = dxf.layers.get(name);
      expect(layer, name).toBeDefined();
      expect(Number(str(layer!, 370))).toBe(Math.round(c.lw * 100));
      expect(Number(str(layer!, 420))).toBe(parseInt(c.color.slice(1), 16));
    }
  });

  it("jede übergebene Entität kommt an (Typ, Anzahl, Reihenfolge der Ebenen)", () => {
    const dxf = readDxf(buildPlanDxf(plan, sampleProject));
    expect(countByType(dxf.entities)).toEqual(flatCounts(plan, sampleProject));
    expect(dxf.entities.every((e) => dxf.layers.has(e.layer))).toBe(true);
  });

  it("ohne Schraffuren: nur die HATCH-Linien fallen weg", () => {
    const withH = readDxf(buildPlanDxf(plan, sampleProject)).entities;
    const without = readDxf(buildPlanDxf(plan, sampleProject, { includeHatches: false })).entities;
    expect(without.some((e) => e.layer === "HATCH")).toBe(false);
    expect(without.length).toBe(withH.filter((e) => e.layer !== "HATCH").length);
  });
});

describe("Georeferenz (LV95)", () => {
  const anchored: Project = {
    ...sampleProject,
    geoAnchor: { lv95: { e: 2_600_123.456_789_1, n: 1_200_456.987_654_3 }, model: { x: 0, y: 0 } },
  };
  const world = projectToWorldCoords(anchored);
  const plan = generatePlan(world, "eg", allCodes(world));
  const polys = plan.primitives.filter((p): p is Extract<Plan["primitives"][number], { kind: "polygon" }> => p.kind === "polygon");

  it("DXF: Polylinien-Koordinaten bitgleich zum Plan (f64, keine Rundung)", () => {
    const ents = readDxf(buildPlanDxf(plan, world)).entities.filter((e) => e.type === "LWPOLYLINE");
    expect(ents.length).toBe(polys.length);
    expect(polys[0].pts[0].x).toBeGreaterThan(2_600_000);
    for (let i = 0; i < polys.length; i++) {
      expect(nums(ents[i], 10)).toEqual(polys[i].pts.map((p) => p.x));
      expect(nums(ents[i], 20)).toEqual(polys[i].pts.map((p) => p.y));
    }
  });

  it("DWG (libredwg gelesen): dieselben Koordinaten", async () => {
    const read = await libreDwgReader();
    const db = read(buildPlanDwg(plan, world));
    const ents = db.entities.filter((e) => e.type === "LWPOLYLINE");
    expect(ents.length).toBe(polys.length);
    for (let i = 0; i < polys.length; i++) {
      expect(ents[i].vertices!.map((v) => [v.x, v.y])).toEqual(polys[i].pts.map((p) => [p.x, p.y]));
    }
  });
});

describe("DWG-Export (R2018 über acadrust, gegengelesen mit libredwg)", () => {
  it("gleiche Entitäten und Ebenen wie das DXF", async () => {
    const plan = generatePlan(sampleProject, "og", allCodes(sampleProject));
    const bytes = buildPlanDwg(plan, sampleProject);
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe("AC1032");
    const db = (await libreDwgReader())(bytes);
    const dxf = readDxf(buildPlanDxf(plan, sampleProject));
    expect(countByType(db.entities)).toEqual(countByType(dxf.entities));
    expect(db.entities.map((e) => e.layer)).toEqual(dxf.entities.map((e) => e.layer));
    const dwgLayers = new Map(db.tables.LAYER.entries.map((l) => [l.name, l]));
    for (const [name, l] of dxf.layers) {
      expect(dwgLayers.has(name), name).toBe(true);
      if (name !== "0") expect(dwgLayers.get(name)!.color).toBe(Number(str(l, 420)));
    }
  });
});

describe("Umlaute in Ebenen- und Textnamen", () => {
  const cat0 = sampleProject.layers[0];
  const project: Project = { ...sampleProject, layers: [{ ...cat0, name: "Aussenwände Süd" }, ...sampleProject.layers.slice(1)] };
  const plan = {
    primitives: [
      { kind: "polygon", pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], drawingId: "d1", fill: "none", stroke: "#000", strokeWidthMm: 0.25, hatch: { pattern: "none", scale: 1, angle: 0, color: "#000", lineWeight: 0.13, dash: null } },
      { kind: "drawingText", at: { x: 2.5, y: 1.25 }, text: "Küche/Essen ≥ 12 m² «Süd»", heightM: 0.3, angle: Math.PI / 6, color: "#000", drawingId: "d1" },
    ],
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  } as unknown as Plan;
  const withDrawing: Project = {
    ...project,
    drawings2d: [{ ...(sampleProject.drawings2d[0] ?? {}), id: "d1", categoryCode: cat0.code } as Project["drawings2d"][number]],
  };
  const layer = `${cat0.code}_Aussenwände_Süd`;

  it("DXF (UTF-8): Ebene und Text unverändert", () => {
    const dxf = readDxf(buildPlanDxf(plan, withDrawing));
    expect(dxf.layers.has(layer)).toBe(true);
    const text = dxf.entities.find((e) => e.type === "TEXT")!;
    expect(text.layer).toBe(layer);
    expect(str(text, 1)).toBe("Küche/Essen ≥ 12 m² «Süd»");
    expect([num(text, 10), num(text, 20), num(text, 40)]).toEqual([2.5, 1.25, 0.3]);
    expect(num(text, 50)).toBeCloseTo(30, 10);
    expect(dxf.entities.find((e) => e.type === "LWPOLYLINE")!.layer).toBe(layer);
  });

  it("DWG (libredwg): Ebene und Text unverändert", async () => {
    const db = (await libreDwgReader())(buildPlanDwg(plan, withDrawing));
    expect(db.tables.LAYER.entries.some((l) => l.name === layer)).toBe(true);
    const text = db.entities.find((e) => e.type === "TEXT")!;
    expect(text.layer).toBe(layer);
    expect(text.text).toBe("Küche/Essen ≥ 12 m² «Süd»");
  });
});
