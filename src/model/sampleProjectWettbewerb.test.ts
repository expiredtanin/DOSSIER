// [210] Beispielprojekt „Wettbewerb": gültig, deterministisch, Plan/Schnitt/Ansicht/3D rechnen, Baurecht, Kennzahlen,
// Raumprogramm und Präsentationsplan sind vorhanden. Mit WB_OUT=<pfad.obp> schreibt der Test die Projektdatei
// (zum Ansehen über dossier-cli, Bilder der Kurzanleitung).

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { buildWettbewerbSampleProject } from "./sampleProjectWettbewerb";
import { projectWarnings, validateProject } from "../core/ops";
import { generatePlan } from "../plan/generatePlan";
import { computeSection, generateSectionPlan } from "../plan/toSection";
import { generateElevationPlan } from "../plan/toElevation";
import { projectToModel3d } from "../plan/toWalls3d";
import { computeKennzahlen } from "../analysis/kennzahlen";
import { checkSiteRules } from "../analysis/siteRules";
import { serializeProject, parseProjectFile } from "../io/projectFormat";
import { collectVisibleCodes } from "./types";

const p = buildWettbewerbSampleProject();
const codes = collectVisibleCodes(p.layers);

describe("Beispielprojekt Wettbewerb", () => {
  it("ist gültig und deterministisch; Datei-Rundreise", () => {
    expect(validateProject(p)).toEqual([]);
    expect(projectWarnings(p)).toEqual([]);
    const text = serializeProject(p);
    expect(serializeProject(buildWettbewerbSampleProject())).toBe(text);
    expect(parseProjectFile(text).ok).toBe(true);
    if (process.env.WB_OUT) writeFileSync(process.env.WB_OUT, text);
  });

  it("drei Geschosse mit Wänden, Decken, Treppen, Flachdach und Räumen", () => {
    const floors = p.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId).map((l) => l.id);
    expect(floors).toEqual(["eg", "og1", "og2"]);
    for (const f of floors) {
      expect(p.walls.filter((w) => w.floorId === f && w.isExternal).length).toBe(4);
      expect(p.rooms!.filter((r) => r.floorId === f).length).toBe(10);
    }
    expect(p.ceilings!.length).toBe(3);
    expect(p.roofs![0].shape).toBe("flach");
    expect(p.stairs!.length).toBe(2);
    expect(p.rooms!.length).toBe(30);
  });

  it("Grundrisse, Schnitte und Ansichten rechnen", async () => {
    for (const l of p.drawingLevels.filter((x) => x.kind === "floor" && !x.layoutId)) {
      expect(generatePlan(p, l.id, codes, undefined, "mittel", false, false, true, 200).primitives.length, l.id).toBeGreaterThan(50);
    }
    for (const l of p.drawingLevels.filter((x) => x.kind === "section")) {
      const o = await computeSection(p, l);
      expect(o, l.id).not.toBeNull();
      expect(generateSectionPlan(o!, false, { visibleCodes: codes, openings: true, scaleDenominator: 200 }).primitives.length, l.id).toBeGreaterThan(50);
    }
    for (const l of p.drawingLevels.filter((x) => x.kind === "elevation")) {
      expect(generateElevationPlan(p, l, { scaleDenominator: 200 })?.primitives.length ?? 0, l.id).toBeGreaterThan(50);
    }
    expect(projectToModel3d(p).walls.length).toBeGreaterThan(30);
  });

  it("Baurecht: Parzelle, Grenzabstände, Gesamthöhe; Gebäude steht innerhalb", () => {
    expect(p.siteRules?.parcel.length).toBe(4);
    expect(p.siteRules?.maxHeight).toBe(12);
    expect(p.parcelArea).toBe(880);
    expect(p.geoAnchor?.lv95.e).toBeGreaterThan(2_000_000);
    const r = checkSiteRules(p) as { violations?: unknown[] } | null;
    expect(r).toBeTruthy();
    expect(r!.violations ?? []).toEqual([]);
  });

  it("Kennzahlen und Raumprogramm", () => {
    const k = computeKennzahlen(p);
    expect(k.gf).toBeGreaterThan(600);
    expect(k.gf).toBeLessThan(800);
    expect(p.roomProgram!.length).toBe(7);
    // Soll und Ist liegen im gleichen Rahmen: Wohnungen 6 ×.
    expect(p.rooms!.filter((r) => r.name === "Wohnen/Essen").length).toBe(6);
  });

  it("Präsentationsplan A1 mit Grundrissen, Ansichten und Schnitt; Situation", () => {
    const sheet = p.layouts!.find((l) => l.name.includes("Präsentation"));
    expect(sheet?.paper).toBe("a1");
    expect(sheet!.viewports.length).toBe(3 + 4 + 1);
    expect(sheet!.viewports.every((v) => v.scaleDenominator === 200)).toBe(true);
    const sit = p.layouts!.find((l) => l.id === "lay-situation");
    expect(sit?.viewports[0].scaleDenominator).toBe(500);
    expect(p.viewSnapshots!.find((s) => s.id === "vs-situation")?.templateId).toBe("std-vt-situation-wbw");
  });
});
