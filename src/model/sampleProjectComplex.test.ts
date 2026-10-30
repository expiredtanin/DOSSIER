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
import { collectVisibleCodes } from "./types";

const p = buildComplexSampleProject();
const codes = collectVisibleCodes(p.layers);

describe("Musterhaus komplex", () => {
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

  it("enthält alle Bauteil-Arten", () => {
    expect(p.drawingLevels.filter((l) => l.kind === "floor").map((l) => l.id)).toEqual(["ug", "eg", "og", "dg"]);
    expect(p.rooms!.length).toBeGreaterThanOrEqual(20);
    expect(p.roofs!.some((r) => (r.dormers ?? []).length === 2)).toBe(true);
    expect(p.stairs!.map((s) => s.shape).sort()).toEqual(["L", "spiral", "straight"]);
    expect(p.context!.map((c) => c.type).sort()).toEqual(["contourSet", "excavation", "terrainMesh"]);
    expect(p.extrudedSolids!.filter((s) => s.brep).length).toBe(2);
    expect(p.drawings2d.filter((d) => d.geom.shape === "dimension").length).toBeGreaterThan(8);
    const frameKinds = new Set(p.doorTypes!.map((d) => d.frameKind ?? d.kind));
    for (const k of ["blockrahmen", "umfassungszarge", "futter", "schiebe", "eckzarge", "wandoeffnung"]) expect(frameKinds).toContain(k);
  });

  it("Grundrisse aller Geschosse und das Detail rechnen", () => {
    for (const l of p.drawingLevels.filter((x) => x.kind === "floor" || x.kind === "drawing")) {
      const plan = generatePlan(p, l.id, codes, undefined, "mittel", false, false, true, 100);
      expect(plan.primitives.length, l.id).toBeGreaterThan(50);
    }
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
