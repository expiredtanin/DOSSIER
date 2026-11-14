// [208] Anonyme Wettbewerbs-Abgabe: kein Export verrät Büro, Bearbeiter:in, Projektname oder Projektnummer — nur das
// Kennwort. Ein Beispielprojekt mit gesetzten Namen geht durch alle Formate (PDF-Info und -Text, Berichte als CSV/PDF,
// IFC4/IFC2x3, DXF ASCII/Binär/DWG, SVG, OBJ/MTL/STL/glTF, STEP, CSV, Blender-Paket); danach darf keiner der Namen
// vorkommen (Gross-/Kleinschreibung egal). Gegenprobe: ohne Anonymität stehen die Namen in den Ausgaben, der Test
// prüft also wirklich etwas. Muster: e2e `competition`, `layoutPdf.images.test.ts`.

import "../engine/fileioWasm.setup";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { createPosterMaster, posterTemplate } from "../model/posterTemplates";
import { flattenCategories } from "../model/types";
import type { Layout, Project } from "../model/types";
import { generatePlan } from "../plan/generatePlan";
import { buildPlanDwg, buildPlanDxf, buildPlanDxfBinary } from "./exportDxf";
import { exportIfcSpf } from "./exportIfc";
import { exportGlb, exportGltf, exportMtl, exportObj, exportStl } from "./exportMesh";
import { exportScheduleCsv } from "./exportSchedule";
import { exportProjectStep } from "./exportStep";
import { captureJsPdfText, pdfVisibleText } from "./pdfText.testing";
import { buildPagesPdf, layoutPages, pdfBytes } from "./layoutPdf";
import { planToSvgString } from "./planToSvgString";
import { areaReportToCsv, buildAreaReport, buildAreaReportPdf } from "./areaReport";
import { buildProgramReport } from "./programReport";
import { buildRoomBookReport } from "./roomBook";
import { buildOpeningReport } from "./openingSchedule";
import { buildElementReport } from "./elementSchedule";
import { buildCostReport } from "./costReport";
import { buildRenderPackage } from "./blenderRender";
import { identityLeaks, identifyingTexts, NEUTRAL_ISO } from "./competitionIdentity";
import { pdfInfoText } from "./pdfInfo";

const OFFICE = "BUEROXYZ Architekten AG";
const AUTHOR = "BEARBEITERQ Muster";
const NAME = "PROJEKTNAMEZ Haus";
const NUMBER = "NUMMER4711";
const KEYWORD = "FALKE 7";
const SECRETS = [OFFICE, AUTHOR, NAME, NUMBER];

/** Ganzes Beispielprojekt mit Büro-, Bearbeiter- und Projektangaben; Blatt mit Plakat-Kopf (zeigt Projekt/Autor). */
function project(anonymous: boolean | null): Project {
  const master = createPosterMaster("m1", posterTemplate("poster-a1-landscape")!);
  master.titleBlock = { projectName: `${OFFICE} ${NAME}`, author: AUTHOR };
  const layout: Layout = { id: "l1", name: "Grundriss", paper: "a1", orientation: "landscape", masterId: "m1", viewports: [] };
  return {
    ...sampleProject,
    name: NAME,
    projectNumber: NUMBER,
    masterLayouts: [master],
    layouts: [layout],
    ...(anonymous === null ? {} : { competition: { anonymous, keyword: KEYWORD } }),
  } as Project;
}

const latin1 = (b: Uint8Array): string => Buffer.from(b).toString("latin1");

/** Seiteninhalt (Flate-Streams) des PDF entpackt, hintereinander. */
function streamsText(bytes: Uint8Array, captured = ""): string {
  const all = Buffer.from(bytes);
  const text = all.toString("latin1");
  let out = "";
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const from = m.index! + m[0].length;
    const to = text.indexOf("endstream", from);
    try {
      out += inflateSync(all.subarray(from, to)).toString("latin1") + "\n";
    } catch {
      // kein Flate-Stream
    }
  }
  // `captured`: die an jsPDF übergebenen Zeichenketten — gilt auch ohne Poppler (`pdftotext`), das den Glyphen-Text liest.
  return out + "\n" + pdfVisibleText(bytes) + "\n" + captured;
}

/** Alle Ausgaben, die ohne Browser/GPU entstehen: Name → Text (Binärformate als latin1). */
async function allOutputs(p: Project): Promise<Record<string, string>> {
  const plan = generatePlan(p, "eg", new Set(flattenCategories(p.layers).map((l) => l.code)));
  const out: Record<string, string> = {};
  // PDF: Blatt (Info + Seiteninhalt) und Berichte (Info + Inhalt)
  const cap = captureJsPdfText();
  let mark = cap.mark();
  const doc = await buildPagesPdf(p, layoutPages(p, ["l1"]));
  const sheet = pdfBytes(p, doc!);
  out["PDF-Blatt"] = latin1(sheet);
  out["PDF-Blatt-Text"] = streamsText(sheet, cap.since(mark));
  out["PDF-Blatt-Info"] = pdfInfoText(sheet);
  const reports = { Flaechen: buildAreaReport(p, { ivhb: true }), Programm: buildProgramReport(p), Raumbuch: buildRoomBookReport(p), Oeffnungen: buildOpeningReport(p), Bauteile: buildElementReport(p), Kosten: buildCostReport(p) };
  for (const [name, report] of Object.entries(reports)) {
    out[`CSV-${name}`] = areaReportToCsv(report);
    mark = cap.mark();
    const bytes = new Uint8Array((await buildAreaReportPdf(report)).output("arraybuffer"));
    out[`PDF-${name}`] = latin1(bytes);
    out[`PDF-${name}-Text`] = streamsText(bytes, cap.since(mark));
    out[`PDF-${name}-Info`] = pdfInfoText(bytes);
  }
  cap.restore();
  // IFC
  out["IFC4"] = exportIfcSpf(p);
  out["IFC2x3"] = exportIfcSpf(p, { schema: "IFC2X3" });
  // DXF/DWG (mit Papierbereich der Projekt-Layouts)
  out["DXF"] = buildPlanDxf(plan, p, { paperLayout: true, levelId: "eg" });
  out["DXF-binaer"] = latin1(buildPlanDxfBinary(plan, p, { paperLayout: true, levelId: "eg" }));
  out["DWG"] = latin1(buildPlanDwg(plan, p, { paperLayout: true, levelId: "eg" }));
  // SVG, Mesh, CSV
  out["SVG"] = planToSvgString(plan, { hatch: true });
  out["OBJ"] = exportObj(p, {}, "m.mtl");
  out["OBJ-ohne-MTL"] = exportObj(p);
  out["MTL"] = exportMtl(p);
  out["STL"] = exportStl(p);
  out["glTF"] = exportGltf(p);
  out["GLB"] = latin1(exportGlb(p));
  out["CSV-Bauteilliste"] = exportScheduleCsv(p);
  // STEP (truck-WASM)
  const mod: any = await import("../engine/pkgTruck/trucksolid.js");
  await mod.default({ module_or_path: readFileSync("src/engine/pkgTruck/trucksolid_bg.wasm") });
  out["STEP"] = (await exportProjectStep(p)).text;
  // Blender-Paket (scene.json)
  const pkg = await buildRenderPackage(p, { width: 640, height: 360, samples: 16, when: new Date(Date.UTC(2026, 5, 21, 10, 0, 0)), camera: { preset: "iso" } });
  out["Blender-scene.json"] = new TextDecoder().decode(pkg.files.find((f) => f.path === "scene.json")!.bytes);
  return out;
}

describe("anonyme Wettbewerbs-Abgabe in allen Ausgaben", () => {
  it("Gegenprobe: ohne Anonymität stehen die Angaben in den Ausgaben (der Test prüft etwas)", async () => {
    const p = project(false);
    expect(identifyingTexts(p)).toEqual(expect.arrayContaining([NAME, NUMBER, AUTHOR]));
    const o = await allOutputs(p);
    for (const [where, what] of [
      ["IFC4", NAME],
      ["CSV-Flaechen", NAME],
      ["PDF-Flaechen-Text", NAME],
      ["PDF-Blatt-Text", NAME],
      ["PDF-Blatt-Info", AUTHOR],
      ["Blender-scene.json", NAME],
    ] as const) {
      expect(o[where], where).toContain(what);
    }
  }, 120000);

  it("anonym: keine Ausgabe nennt Büro, Bearbeiter:in, Projektname oder Projektnummer", async () => {
    const p = project(true);
    const o = await allOutputs(p);
    const leaks: string[] = [];
    for (const [where, text] of Object.entries(o)) {
      for (const secret of SECRETS) if (text.toLowerCase().includes(secret.toLowerCase())) leaks.push(`${where}: ${secret}`);
      for (const l of identityLeaks(p, text)) leaks.push(`${where}: ${l}`);
    }
    expect(leaks).toEqual([]);
  }, 120000);

  it("anonym: das Kennwort steht, wo es stehen soll", async () => {
    const o = await allOutputs(project(true));
    expect(o["PDF-Blatt-Text"]).toContain(KEYWORD);
    expect(o["PDF-Blatt-Info"]).toContain(`/Title (${KEYWORD})`);
    expect(o["PDF-Flaechen-Info"]).toContain(`/Title (${KEYWORD})`);
    expect(o["PDF-Flaechen-Text"]).toContain(KEYWORD);
    expect(o["CSV-Flaechen"].split("\n")[1]).toBe(KEYWORD);
    expect(o["IFC4"]).toContain(`IFCPROJECT('`);
    expect(o["IFC4"]).toContain(`'${KEYWORD}'`);
    expect(o["IFC4"]).toContain(`FILE_NAME('${KEYWORD}.ifc','${NEUTRAL_ISO}'`);
    expect(JSON.parse(o["Blender-scene.json"]).project).toBe(KEYWORD);
  }, 120000);

  it("anonym: keine Zeit- und Erzeugerspuren in PDF-Info, IFC und STEP", async () => {
    const o = await allOutputs(project(true));
    const year = String(new Date().getFullYear());
    for (const key of ["PDF-Blatt-Info", "PDF-Flaechen-Info", "PDF-Raumbuch-Info"]) {
      expect(o[key], key).not.toMatch(/jsPDF|Dossier/i);
      expect(o[key], key).not.toContain(`D:${year}`);
      expect(o[key], key).toContain("D:20000101000000");
    }
    for (const key of ["IFC4", "IFC2x3"]) {
      // „Dossier_Qto_…" ist der Name eines Eigenschaftssatzes (Programm-Konvention), keine Angabe zur Herkunft.
      expect(o[key].replace(/Dossier_Qto_/g, ""), key).not.toMatch(/dossier/i);
      expect(o[key], key).not.toContain(`${year}-`);
      expect(o[key], key).toContain(`'${NEUTRAL_ISO}'`);
    }
    expect(o["STEP"]).not.toContain(`${year}-`);
    expect(o["STEP"]).toContain("2000-01-01 00:00:00.000");
  }, 120000);

  it("anonym: Blattnamen der Projekt-Layouts erscheinen im DXF nur als „Blatt n“", async () => {
    const p = project(true);
    p.layouts = [{ ...p.layouts![0], name: `${OFFICE} Plan 1` }];
    const plan = generatePlan(p, "eg", new Set(flattenCategories(p.layers).map((l) => l.code)));
    const dxf = buildPlanDxf(plan, p, { paperLayout: true, levelId: "eg" });
    expect(dxf).not.toContain("BUEROXYZ");
    expect(dxf).toContain("Blatt_1");
    const plain = { ...p, competition: undefined } as Project;
    expect(buildPlanDxf(plan, plain, { paperLayout: true, levelId: "eg" })).toContain("BUEROXYZ_Architekten_AG_Plan_1");
  });
});
