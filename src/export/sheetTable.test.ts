import { describe, expect, it } from "vitest";
import { jsPDF } from "jspdf";
import { sampleProject } from "../model/sampleProject";
import type { Layout, LayoutTable, Opening, Project } from "../model/types";
import { drawTablesPdf, sheetTables, tableCatalog, tableLabels } from "./sheetTable";
import { buildElementReport, elementSchedule, uValueOf } from "./elementSchedule";
import { collectPlanDrawing } from "./exportDxf";
import { generatePlan } from "../plan/generatePlan";

const table = (over: Partial<LayoutTable> = {}): LayoutTable => ({ id: "tb", source: "openings", xMm: 10, yMm: 20, widthMm: 180, ...over });

function withTables(tables: LayoutTable[], p: Project = sampleProject): Project {
  const layout: Layout = { id: "L1", name: "Blatt", paper: "a3", orientation: "landscape", viewports: [], tables };
  return { ...p, layouts: [layout] };
}

/** Sichtbarer Text einer PDF-Seite (unkomprimierter Inhaltsstrom: `(text) Tj`). */
function pdfText(doc: jsPDF): string {
  return doc.output();
}

describe("Tabellen auf dem Blatt ([111])", () => {
  it("Fenster-/Türliste: eine Zeile je Öffnung, wächst mit dem Modell", () => {
    const p = withTables([table()]);
    const n = (p.openings ?? []).length;
    const [a] = sheetTables(p, "L1");
    expect(a.total).toBe(n);
    expect(a.shown).toBe(n);
    const texts = a.prims.filter((x) => x.k === "text").map((x) => (x as { s: string }).s);
    expect(texts).toContain("F1.01");
    // Ein weiteres Fenster im Modell: die Tabelle hat eine Zeile mehr und ist höher.
    const first = (p.openings ?? []).find((o) => o.kind === "window")!;
    const extra: Opening = { ...first, id: "neu-fenster", mark: "F-NEU" };
    const p2: Project = { ...p, openings: [...(p.openings ?? []), extra] };
    const [b] = sheetTables(p2, "L1");
    expect(b.total).toBe(n + 1);
    expect(b.heightMm).toBeGreaterThan(a.heightMm);
    expect(b.prims.some((x) => x.k === "text" && x.s === "F-NEU")).toBe(true);
  });

  it("Spaltenwahl, Filter und Aufteilen auf zwei Rahmen", () => {
    const p = withTables([
      table({ id: "a", columns: ["mark", "type"], filter: "window", heightMm: 12 }),
      table({ id: "b", continues: "a", xMm: 100, heightMm: 40 }),
    ]);
    const [a, b] = sheetTables(p, "L1");
    const windows = (p.openings ?? []).filter((o) => o.kind === "window").length;
    expect(a.total).toBe(windows);
    expect(a.shown).toBeLessThan(windows); // 12 mm = Kopf + 1 Zeile
    expect(b.shown).toBeGreaterThan(0);
    expect(a.shown + b.shown + b.hidden).toBe(windows);
    // Die Fortsetzung erbt Quelle, Spalten und Filter.
    expect(b.prims.filter((x) => x.k === "text" && x.s === tableLabels(p)["openings.col.mark"]).length).toBe(1);
  });

  it("alle vier Quellen liefern Primitive; Katalog nennt die Spalten", () => {
    const cat = tableCatalog(sampleProject);
    expect(Object.keys(cat.sources).sort()).toEqual(["areas", "elements", "openings", "rooms"]);
    const p = withTables((["openings", "areas", "rooms", "elements"] as const).map((source) => table({ id: source, source })));
    const out = sheetTables(p, "L1");
    expect(out.map((o) => o.id)).toEqual(["openings", "areas", "rooms", "elements"]);
    for (const o of out) expect(o.prims.some((x) => x.k === "text")).toBe(true);
  });

  it("PDF: Tabellentext als Vektor (Text im Inhaltsstrom)", () => {
    const p = withTables([table({ columns: ["mark", "type", "width"] })]);
    const doc = new jsPDF({ unit: "mm", format: [420, 297], orientation: "landscape", compress: false });
    drawTablesPdf(doc, sheetTables(p, "L1"));
    const pdf = pdfText(doc);
    expect(pdf).toContain("(F1.01)");
    expect(pdf).toContain(`(${tableLabels(p)["openings.col.mark"]})`);
  });

  it("DXF-Layout: Tabelle als Block mit Text", () => {
    const p = withTables([table({ columns: ["mark", "type"] })]);
    const plan = generatePlan(p, p.drawingLevels[0]!.id, new Set(), undefined, "fein", false, false, false, 100, true);
    const texts = String(collectPlanDrawing(plan, p, { paperLayout: true, levelId: p.drawingLevels[0]!.id }).args()[1]).split("\0");
    expect(texts).toContain("SHEETTAB_1");
    expect(texts).toContain("F1.01");
    expect(texts).toContain(tableLabels(p)["openings.col.mark"]);
  });
});

describe("Bauteilliste und U-Wert ([71])", () => {
  it("Beispielprojekt: Zeilen je Wand, U-Wert aus den Schichten", () => {
    const rows = elementSchedule(sampleProject);
    expect(rows.length).toBeGreaterThanOrEqual(sampleProject.walls.length);
    for (const r of rows.filter((x) => x.complete)) expect(r.u!).toBeGreaterThan(0);
    const rep = buildElementReport(sampleProject);
    expect(rep.sections.length).toBeGreaterThan(0);
  });

  it("Aufbau ohne λ ist unvollständig, mit λ handgerechnet", () => {
    const comps = [
      { ...sampleProject.components[0]!, id: "c-b", lambda: 2.3 },
      { ...sampleProject.components[0]!, id: "c-d", lambda: 0.035 },
      { ...sampleProject.components[0]!, id: "c-x", lambda: undefined },
    ];
    const p: Project = { ...sampleProject, components: comps };
    const layers = (ids: string[]) => ids.map((componentId, i) => ({ componentId, thickness: [0.16, 0.2, 0.1][i]! }));
    const ok = uValueOf(p, "wall", { layers: layers(["c-d", "c-b"]) })!;
    expect(ok.complete).toBe(true);
    expect(ok.u!).toBeCloseTo(1 / (0.17 + 0.16 / 0.035 + 0.2 / 2.3), 6);
    const bad = uValueOf(p, "wall", { layers: layers(["c-x", "c-b"]) })!;
    expect(bad.complete).toBe(false);
    expect(bad.u).toBeNull();
    expect(bad.missing).toBe(1);
  });
});
