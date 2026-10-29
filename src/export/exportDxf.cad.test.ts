// Fachplaner-Export ([C2], 28.10.): DIMENSION mit Anonymblock und DIMSTYLE, BLOCK/INSERT/ATTRIB für Türen,
// Fenster und Möbelblöcke, Linientypen, Textstile, Papierbereich — gegengelesen mit ezdxf (Auditor, wie
// ein CAD-Programm die Datei sieht), libredwg (DWG) und dem eigenen DXF-Import. ezdxf-Teile werden ohne
// `pip install ezdxf` übersprungen (Muster `exportDxf.ezdxf.test.ts`).

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanDwg, buildPlanDxf, buildPlanDxfBinary, collectPlanDrawing } from "./exportDxf";
import { countByType, libreDwgReader, readDxf } from "./cadReadBack.testutil";
import { inspectDxf } from "../io/importView.testutil";
import { sampleProject } from "../model/sampleProject";
import { generatePlan } from "../plan/generatePlan";
import { flattenCategories } from "../model/types";
import type { Drawing2D, Project } from "../model/types";

const hasEzdxf = spawnSync("python3", ["-c", "import ezdxf"]).status === 0;
const allCodes = (p: Project) => new Set(flattenCategories(p.layers).map((l) => l.code));

/** Demo-Haus plus Bemassungskette, gestrichelte Linie, Möbelblock (2 Instanzen), Text mit Schrift. */
function cadProject(): Project {
  const code = "90";
  const d = (id: string, geom: Drawing2D["geom"], extra: Partial<Drawing2D> = {}): Drawing2D =>
    ({ id, type: "drawing2d", levelId: "eg", categoryCode: code, geom, ...extra }) as Drawing2D;
  return {
    ...sampleProject,
    lineStyles: [...sampleProject.lineStyles, { id: "ls-dash", name: "Strichlinie 0.3/0.1", weight: 0.13, color: "#000000", dash: [3, 1] }],
    textStyles: [{ id: "body", label: "Text", marks: { font: '"Helvetica Neue", Arial, sans-serif' } }],
    blockDefs: [
      {
        id: "bd-sofa",
        name: "Sofa",
        geom2d: [
          { shape: "rect", min: { x: -0.9, y: -0.4 }, max: { x: 0.9, y: 0.4 } },
          { shape: "line", a: { x: -0.9, y: 0.2 }, b: { x: 0.9, y: 0.2 } },
        ],
      },
    ],
    drawings2d: [
      d("dim1", { shape: "dimension", pts: [{ x: 0, y: -1 }, { x: 2, y: -1 }, { x: 5, y: -1 }], offset: -0.8 }),
      d("dash1", { shape: "line", a: { x: 0, y: -2 }, b: { x: 4, y: -2 } }, { lineStyleId: "ls-dash" }),
      d("sofa1", { shape: "block", blockDefId: "bd-sofa", at: { x: 1.5, y: 1 }, rotation: 0 }),
      d("sofa2", { shape: "block", blockDefId: "bd-sofa", at: { x: 3.5, y: 2.5 }, rotation: Math.PI / 2, scale: 1.5 }),
      d("txt1", { shape: "text", at: { x: 1, y: 4 }, text: "Müller & Söhne", height: 0.2, angle: 0 }),
    ],
  };
}

interface Ez {
  version: string;
  errors: string[];
  entities: Array<Record<string, unknown> & { type: string; layer: string }>;
  blocks: Record<string, { entities: Record<string, number>; anonymous: boolean }>;
  styles: Record<string, string | null>;
  fonts: Record<string, string>;
  linetypes: Record<string, number[]>;
  dimstyles: Record<string, Record<string, unknown>>;
  layouts: Record<string, { viewports: Array<{ id: number; center: number[]; size: number[]; view_center: number[]; view_height: number }>; paper: number[] | null }>;
}

function ezdxf(name: string, data: string | Uint8Array): { status: number | null; r: Ez; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "dossier-cad-"));
  const file = join(dir, `${name}.dxf`);
  writeFileSync(file, data);
  const p = spawnSync("python3", ["scripts/validate-dxf.py", file], { encoding: "utf8", timeout: 60_000 });
  let r = null as unknown as Ez;
  try {
    r = JSON.parse(p.stdout) as Ez;
  } catch {
    /* Fehlertext unten */
  }
  return { status: p.status, r, err: `${p.stdout}\n${p.stderr}` };
}

describe("Fachplaner-Export: Sammler", () => {
  const project = cadProject();
  const plan = generatePlan(project, "eg", allCodes(project));

  it("Bemassung, Blöcke und Öffnungen werden zu CAD-Objekten statt zu losen Linien", () => {
    const { model, blocks } = collectPlanDrawing(plan, project).stats();
    expect(model.DIMENSION).toBe(2); // zwei Segmente der Kette
    expect(model.INSERT).toBe(3 + 2); // Tür + 2 Fenster des Demo-Hauses, 2 Sofas
    expect(blocks.LINE).toBeGreaterThan(0);
    // Bemassung: ihre Linien/Texte stehen nicht zusätzlich lose im Modellbereich.
    const dimPrims = plan.primitives.filter((p) => "drawingId" in p && p.drawingId === "dim1").length;
    expect(dimPrims).toBeGreaterThan(0);
    const loose = collectPlanDrawing({ ...plan, primitives: plan.primitives.filter((p) => !("drawingId" in p && p.drawingId === "dim1")) }, project).stats();
    expect(loose.model.LINE).toBe(model.LINE);
    expect(loose.model.TEXT).toBe(model.TEXT);
  });

  it("Massstab und Einheit wirken auf Stil und Masszahl", () => {
    const [flat] = collectPlanDrawing(plan, project, { scaleDenominator: 50, dimUnit: "cm" }).args();
    expect(flat.length).toBeGreaterThan(0);
    const dxf = readDxf(buildPlanDxf(plan, project, { scaleDenominator: 50, dimUnit: "cm" }));
    expect(dxf.entities.filter((e) => e.type === "DIMENSION").length).toBe(2);
  });
});

describe.skipIf(!hasEzdxf)("Fachplaner-Export gegen ezdxf", { timeout: 60_000 }, () => {
  const project = cadProject();
  const plan = generatePlan(project, "eg", allCodes(project));
  const read = (opts = {}) => {
    const x = ezdxf("cad", buildPlanDxf(plan, project, opts));
    expect(x.r, x.err).not.toBeNull();
    expect(x.r.errors).toEqual([]);
    expect(x.status).toBe(0);
    return x.r;
  };

  it("DIMENSION: ausgerichtet, mit *D-Block (Hilfslinien, Masslinie, 2 Striche, Zahl) und Stil 1:100", () => {
    const r = read();
    const dims = r.entities.filter((e) => e.type === "DIMENSION");
    expect(dims.map((d) => d.measurement as number)).toEqual([expect.closeTo(2, 9), expect.closeTo(3, 9)]);
    for (const d of dims) {
      expect((d.dimtype as number) & 7).toBe(1); // ausgerichtet
      expect(d.dimstyle).toBe("DOSSIER_1-100");
      const block = r.blocks[d.block as string];
      expect(block?.anonymous, String(d.block)).toBe(true);
      expect(block.entities).toEqual({ LINE: 5, TEXT: 1 });
    }
    const st = r.dimstyles["DOSSIER_1-100"];
    expect(st).toMatchObject({ dimscale: 100, dimtad: 1, dimdec: 2, dimlfac: 1, dimtxsty: "DOSSIER" });
    expect(st.dimtxt as number).toBeCloseTo(0.004, 9); // 4 mm Papier
    expect(st.dimtsz as number).toBeCloseTo(0.0015, 9); // Architekturstrich 3 mm
  });

  it("Bemassungsstil im Massstab 1:50 und in cm", () => {
    const r = read({ scaleDenominator: 50, dimUnit: "cm" });
    const st = r.dimstyles["DOSSIER_1-50_cm"];
    expect(st).toMatchObject({ dimscale: 50, dimdec: 0, dimlfac: 100 });
    const block = r.blocks[r.entities.find((e) => e.type === "DIMENSION")!.block as string];
    expect(block.entities.TEXT).toBe(1);
  });

  it("Türen/Fenster: INSERT in Wandrichtung mit Attributen, Block mit Geometrie", () => {
    const r = read();
    const ins = r.entities.filter((e) => e.type === "INSERT" && !(e.name as string).startsWith("Sofa"));
    expect(ins.length).toBe(3);
    const door = ins.find((i) => (i.attribs as Record<string, string>).TYP === "Tür")!;
    expect(door.name).toBe("Tuer_90x210");
    expect(door.attribs).toMatchObject({ ID: "D1", BREITE_M: "0.90", HOEHE_M: "2.10", TYPENAME: expect.any(String) });
    expect(door.layer).toMatch(/^21_/); // Ebene der Kategorie „Türen/Fenster“
    expect(r.blocks[door.name as string].entities.LINE).toBeGreaterThan(0);
    const win = ins.find((i) => (i.attribs as Record<string, string>).TYP === "Fenster")!;
    expect(win.attribs).toMatchObject({ BRUESTUNG_M: "0.90" });
  });

  it("Möbelblock: ein BLOCK je Definition, zwei INSERTs mit Drehung und Skalierung", () => {
    const r = read();
    const sofas = r.entities.filter((e) => e.type === "INSERT" && e.name === "Sofa");
    expect(sofas.length).toBe(2);
    expect(sofas[0].at).toEqual([1.5, 1]);
    expect(sofas[1].rotation as number).toBeCloseTo(90, 9);
    expect(sofas[1].scale).toEqual([1.5, 1.5]);
    expect(r.blocks.Sofa.entities).toEqual({ LINE: 5 }); // Rechteck = 4 Linien + 1 Linie, lokal
    // Geometrie lokal um den Einfügepunkt (Rechteck −0.9…0.9), nicht an der Weltlage
    const sofaLines = r.entities.filter((e) => e.type === "LINE" && Math.abs((e.pts as number[][])[0][0] - 1.5) < 1.0 && Math.abs((e.pts as number[][])[0][1] - 1) < 0.5 && e.layer.startsWith("90_"));
    expect(sofaLines.length).toBe(0); // keine losen Linien an der Weltlage
  });

  it("Strichmuster → Linientyp mit dem Namen des Projekt-Linienstils (Papier-mm × Massstab)", () => {
    const r = read();
    const lt = r.linetypes["Strichlinie_0.3_0.1"];
    expect(lt).toBeDefined();
    expect(lt.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.3, -0.1]); // 3 mm / 1 mm Papier bei 1:100
    const line = r.entities.find((e) => e.type === "LINE" && e.linetype === "Strichlinie_0.3_0.1");
    expect(line).toBeDefined();
    // 1:50 halbiert die Längen
    const r50 = read({ scaleDenominator: 50 });
    expect(r50.linetypes["Strichlinie_0.3_0.1"].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.15, -0.05]);
  });

  it("Textstile: Schriftname aus dem Projekt, Fallback Arial; Umlaute", () => {
    const r = read();
    expect(r.fonts.DOSSIER).toBe("Helvetica Neue");
    const text = r.entities.find((e) => e.type === "TEXT" && e.text === "Müller & Söhne")!;
    expect(text).toBeDefined();
    expect(text.style).toBe("DOSSIER");
    expect(text.halign).toBe(0);
    const noFont = ezdxf("cad2", buildPlanDxf(plan, { ...project, textStyles: [] }));
    expect(noFont.status, noFont.err).toBe(0);
    expect(noFont.r.fonts.DOSSIER).toBe("Arial");
  });

  it("Raumstempel: Name und Fläche als zentrierte TEXTe im Massstab (Punkt → Meter)", () => {
    const r = read();
    const stamps = r.entities.filter((e) => e.type === "TEXT" && e.halign === 1);
    expect(stamps.length).toBeGreaterThan(0);
    const texts = stamps.map((e) => e.text as string);
    expect(texts.some((t) => /m²/.test(t))).toBe(true);
    for (const s of stamps) expect(s.height as number).toBeGreaterThan(0.2); // 10 pt bei 1:100 ≈ 0.35 m
  });

  it("Papierbereich: Layout mit Ansichtsfenster im Planmassstab", () => {
    const r = read({ paperLayout: true });
    const name = Object.keys(r.layouts).find((n) => n.startsWith("Plan_1-100"))!;
    expect(name).toBeDefined();
    const vp = r.layouts[name].viewports.find((v) => v.id === 2)!;
    expect(vp).toBeDefined();
    const [pw, ph] = r.layouts[name].paper!;
    expect(vp.center[0]).toBeCloseTo(pw / 2, 6);
    // Ausschnitt in Metern = Fenstergrösse (mm) / 10 (1:100)
    expect(vp.view_height).toBeCloseTo(vp.size[1] / 10, 6);
    expect(ph).toBeGreaterThan(0);
  });

  it("Binär-DXF trägt dieselben Objekte", () => {
    const asc = ezdxf("asc", buildPlanDxf(plan, project));
    const bin = ezdxf("bin", buildPlanDxfBinary(plan, project));
    expect(bin.r.errors).toEqual([]);
    expect(bin.status, bin.err).toBe(0);
    expect(bin.r.entities).toEqual(asc.r.entities);
    expect(Object.keys(bin.r.blocks)).toEqual(Object.keys(asc.r.blocks));
  });
});

describe("Fachplaner-Export: DWG (libredwg) und eigener Import", () => {
  const project = cadProject();
  const plan = generatePlan(project, "eg", allCodes(project));

  it("DWG R2018: DIMENSION, INSERT, Blöcke und Umlaute kommen an", async () => {
    const db = (await libreDwgReader())(buildPlanDwg(plan, project, { paperLayout: true }));
    const counts = countByType(db.entities);
    expect(counts.DIMENSION).toBe(2);
    expect(counts.INSERT).toBeGreaterThanOrEqual(5);
    const text = db.entities.find((e) => e.type === "TEXT" && e.text?.startsWith("Müller"));
    expect(text?.text).toBe("Müller & Söhne");
  });

  it("DXF-Import: Masszahlen, Möbelgeometrie und Türgeometrie kommen wieder an", () => {
    const imp = inspectDxf(buildPlanDxf(plan, project));
    const texts = (imp.texts ?? []).map((t) => t.text);
    expect(texts).toContain("2.00");
    expect(texts).toContain("3.00");
    expect(texts).toContain("Müller & Söhne");
    // Möbel + Türen/Fenster sind als Geometrie vorhanden (Blöcke werden aufgelöst)
    const lineCount = imp.contours.reduce((n, c) => n + c.contours.length, 0);
    expect(lineCount).toBeGreaterThan(50);
    expect(imp.diagnostics?.entityCounts.DIMENSION ?? imp.diagnostics?.entityCounts.INSERT).toBeDefined();
  });

  it("DXF-Import: Papierbereich wird als Layout erkannt", () => {
    // Das Layout hat nur ein Ansichtsfenster (kein eigener Inhalt) und steht darum nicht in der Liste, ist aber lesbar.
    const dxf = buildPlanDxf(plan, project, { paperLayout: true });
    expect(() => inspectDxf(dxf, "Plan_1-100")).not.toThrow();
  });
});
