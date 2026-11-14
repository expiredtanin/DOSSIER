// Musterhaus komplex: gültig, alle Ebenen/Ansichten rechnen, 3D, Listen und Kennzahlen nicht leer.
// Mit MK_OUT=<pfad.obp> schreibt der Test die Projektdatei (zum Ansehen über dossier-cli).

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { buildComplexSampleProject } from "./sampleProjectComplex";
import { projectWarnings, validateProject } from "../core/ops";
import { generatePlan } from "../plan/generatePlan";
import { computeSection, generateSectionPlan } from "../plan/toSection";
import { generateElevationPlan } from "../plan/toElevation";
import { projectToModel3d } from "../plan/toWalls3d";
import { computeKennzahlen } from "../analysis/kennzahlen";
import { excavationQuantities } from "../analysis/excavation";
import { checkSiteRules } from "../analysis/siteRules";
import { sheetTables } from "../export/sheetTable";
import { serializeProject, parseProjectFile } from "../io/projectFormat";
import { collectVisibleCodes, recomputeFloorElevations } from "./types";

const p = buildComplexSampleProject();
const codes = collectVisibleCodes(p.layers);

describe("Musterhaus komplex", () => {
  it("[227] Nachbargebäude stehen auf dem Gelände, nicht auf z = 0", () => {
    const n = p.context?.find((c) => c.id === "nachbarn");
    if (n?.type !== "importedMesh") throw new Error("Nachbarn fehlen");
    const zs = n.positions.filter((_, i) => i % 3 === 2);
    // Die Höhenlinien reichen bis unter die West- und Ostnachbarn; deren Fuss liegt auf dem Hang (−2.5 … −0.9 m).
    expect(Math.min(...zs)).toBeLessThan(-1);
    expect(Math.min(...zs)).toBeGreaterThan(-3.3);
  });

  it("ist gültig und deterministisch; Datei-Rundreise", () => {
    expect(validateProject(p)).toEqual([]);
    const warnings = projectWarnings(p);
    if (warnings.length) console.info(`Musterhaus komplex — Warnungen:\n${warnings.join("\n")}`);
    expect(warnings).toEqual([]);
    const text = serializeProject(p);
    expect(serializeProject(buildComplexSampleProject())).toBe(text);
    const back = parseProjectFile(text);
    expect(back.ok).toBe(true);
    if (process.env.MK_OUT) writeFileSync(process.env.MK_OUT, text);
  });

  it("[157] Schnitte ohne verdeckte Kanten (nur sichtbare Projektion); verdeckt über eine eigene Vorlage", () => {
    for (const l of p.drawingLevels.filter((l) => l.kind === "section")) expect(l.hiddenLines ?? false).toBe(false);
    expect(p.viewTemplates!.find((t) => t.id === "vt-schnitt")?.hiddenLines ?? false).toBe(false);
    expect(p.viewTemplates!.some((t) => t.hiddenLines === true)).toBe(true);
  });

  it("enthält alle Bauteil-Arten", () => {
    expect(p.drawingLevels.filter((l) => l.kind === "floor").map((l) => l.id)).toEqual(["ug", "eg", "og", "dg"]);
    expect(p.rooms!.length).toBeGreaterThanOrEqual(20);
    expect(p.roofs!.some((r) => (r.dormers ?? []).length === 2)).toBe(true);
    expect(p.stairs!.map((s) => s.shape).sort()).toEqual(["L", "spiral", "straight"]);
    expect(p.context!.map((c) => c.type).sort()).toEqual(["contourSet", "excavation", "importedMesh", "terrainMesh"]);
    expect(p.extrudedSolids!.filter((s) => s.brep).length).toBe(2);
    expect(p.drawings2d.filter((d) => d.geom.shape === "dimension").length).toBeGreaterThan(8);
    const frameKinds = new Set(p.doorTypes!.map((d) => d.frameKind ?? d.kind));
    for (const k of ["blockrahmen", "umfassungszarge", "futter", "schiebe", "eckzarge", "wandoeffnung"]) expect(frameKinds).toContain(k);
  });

  it("[131] EG = ±0.00, UG darunter negativ; Höhen = Stapel des Kerns", () => {
    const z = Object.fromEntries(p.drawingLevels.filter((l) => l.kind === "floor").map((l) => [l.id, l.baseElevation]));
    expect(z).toEqual({ ug: -2.7, eg: 0, og: 2.9, dg: 5.7 });
    expect(p.drawingLevels.find((l) => l.id === "eg")?.zeroLevel).toBe(true);
    const r = recomputeFloorElevations(p.drawingLevels);
    for (const [i, l] of r.entries()) if (l.kind === "floor") expect(l.baseElevation, l.id).toBeCloseTo(p.drawingLevels[i].baseElevation!, 9);
  });

  it("Grundrisse aller Geschosse und das Detail rechnen", () => {
    for (const l of p.drawingLevels.filter((x) => x.kind === "floor" || x.kind === "drawing")) {
      const plan = generatePlan(p, l.id, codes, undefined, "mittel", false, false, true, 100);
      expect(plan.primitives.length, l.id).toBeGreaterThan(50);
    }
  });

  it("[256] EG 1:100: Geländekote und Revisionstext stehen nicht auf Masszahlen", () => {
    const plan = generatePlan(p, "eg", codes, undefined, "mittel", false, false, true, 100);
    const texts = plan.primitives.flatMap((q) => (q.kind === "drawingText" ? [q] : []));
    // Grosszügige Box (Anker unbekannt: links, Mitte oder rechts) um den Text.
    const box = (t: (typeof texts)[number]) => {
      const w = 0.6 * t.heightM * t.text.length;
      return [t.at.x - w, t.at.y - t.heightM, t.at.x + w, t.at.y + t.heightM];
    };
    const hit = (a: number[], b: number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const dims = texts.filter((t) => /^\d+\.\d\d$/.test(t.text)).map(box);
    const labels = texts.filter((t) => t.text.includes("Pfosten-Riegel") || /^[-+]\d+\.\d\d$/.test(t.text));
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const t of labels) expect(dims.some((d) => hit(box(t), d)), t.text).toBe(false);
  });

  it("Schnitte und Ansichten rechnen", async () => {
    for (const l of p.drawingLevels.filter((x) => x.kind === "section")) {
      const o = await computeSection(p, l);
      expect(o, l.id).not.toBeNull();
      const plan = generateSectionPlan(o!, false, { visibleCodes: codes, hiddenLines: true, openings: true, scaleDenominator: 100 });
      expect(plan.primitives.length, l.id).toBeGreaterThan(50);
    }
    for (const l of p.drawingLevels.filter((x) => x.kind === "elevation")) {
      const plan = generateElevationPlan(p, l, { scaleDenominator: 100 });
      expect(plan?.primitives.length ?? 0, l.id).toBeGreaterThan(50);
    }
  });

  it("3D-Modell, Kennzahlen, Baurecht, Erdarbeiten, Listen", () => {
    const m = projectToModel3d(p);
    expect(m.walls.length).toBeGreaterThan(50);
    const k = computeKennzahlen(p);
    expect(k.gf).toBeGreaterThan(300);
    expect(checkSiteRules(p)).toBeTruthy();
    const ex = excavationQuantities(p);
    expect(ex[0].cut).toBeGreaterThan(100);
    for (const layout of p.layouts!.filter((l) => (l.tables ?? []).length)) {
      for (const t of sheetTables(p, layout.id)) expect(t.total, t.id).toBeGreaterThan(0);
    }
  });
});
