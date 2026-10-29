// [76] Vektor-PDF → Import-Form (Kern) → 2D-Zeichnung: Massstab, Ebenen nach Farbe/Strichstärke,
// Flächenfarben, Texte; kaputte Dateien werfen, ohne das WASM-Modul lahmzulegen.

import { beforeAll, describe, expect, it } from "vitest";
import { loadFileioForTests } from "../engine/fileioWasm.testing";
import { isPdfFile, pdfImport, pdfPageInfo, readPdfVector, PT_TO_MM } from "./pdfVector";
import { importInto, viewImport } from "./importView.testutil";
import { emptyProject } from "../model/sampleProject";

const readPdfVectorPage = (bytes: Uint8Array, page = 0) => readPdfVector(bytes, page).page;
/** Modell-Meter je pt bei 1:`scale`. */
const pdfMetersPerPt = (scale: number) => (PT_TO_MM / 1000) * scale;

/** Minimales einseitiges PDF (A4 hoch) mit Inhalt `content`, Schrift F1 = Helvetica. */
function makePdf(content: string, pageExtra = ""): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R ${pageExtra} >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const PLAN =
  "0 0 0 RG 1.4173 w 72 72 m 172 72 l S\n" + // 0.5 mm schwarz, 100 pt lang
  "1 0 0 RG 0.5 w [3 2] 0 d 72 100 m 172 100 l S [] 0 d\n" + // 0.18 mm rot gestrichelt
  "0.5 g 0 0 0 RG 1.4173 w 200 200 50 50 re B\n" + // graue Fläche mit Umriss
  "1 g 0 0 595 842 re f\n" + // weisser Seitenhintergrund (wird weggelassen)
  "0 g BT /F1 10 Tf 72 300 Td (Wohnen) Tj ET";

beforeAll(loadFileioForTests);

describe("Vektor-PDF-Import", () => {
  it("liest Pfade, Farben, Strichstärken und Text in pt", () => {
    const read = readPdfVector(makePdf(PLAN));
    const page = read.page;
    expect(page.pageCount).toBe(1);
    expect([page.width, page.height]).toEqual([595, 842]);
    expect(page.paths).toHaveLength(4);
    expect(page.paths[0]).toMatchObject({ stroke: "#000000", fill: null, closed: false, dash: [] });
    expect(page.paths[0].pts).toEqual([{ x: 72, y: 72 }, { x: 172, y: 72 }]);
    expect(page.paths[1]).toMatchObject({ stroke: "#ff0000", lineWidth: 0.5, dash: [3, 2] });
    expect(page.paths[2]).toMatchObject({ stroke: "#000000", fill: "#808080", closed: true });
    expect(page.texts).toEqual([
      { text: "Wohnen", font: "Helvetica", x: 72, y: 300, size: 10, angle: 0, color: "#000000" },
    ]);
    const info = pdfPageInfo(read);
    expect(info).toMatchObject({ pages: 1, page: 1, paths: 4, texts: 1, bboxPt: [0, 0, 595, 842] });
  });

  it("Massstab 1:100 und Ebenen nach Strichstärke/Farbe → 2D-Zeichnung", () => {
    const parsed = pdfImport(readPdfVector(makePdf(PLAN)), 100);
    const res = viewImport(parsed.src);
    const k = pdfMetersPerPt(100);
    expect(k).toBeCloseTo(0.0352778, 6);
    expect(parsed.summary.unitScale).toBeCloseTo(k, 12);
    expect(res.layerLineWeights["PDF 0.50 #000000"]).toBe(0.5);
    expect(res.layerLineWeights["PDF 0.18 #ff0000 (Strich 1.05/0.7)"]).toBe(0.18);
    expect(res.layerDashes["PDF 0.18 #ff0000 (Strich 1.05/0.7)"]).toEqual([1.05, 0.7]);

    const r = importInto(emptyProject, parsed, { parentName: "Import plan.pdf" });
    const parent = r.project.layers.find((c) => c.name === "Import plan.pdf");
    expect((parent?.children ?? []).map((c) => c.name).sort()).toEqual([
      "PDF 0.18 #ff0000 (Strich 1.05/0.7)",
      "PDF 0.50 #000000",
      "PDF Fläche #808080",
      "PDF Text #000000",
    ]);
    const cat = parent?.children?.find((c) => c.name === "PDF 0.18 #ff0000 (Strich 1.05/0.7)");
    expect(cat).toMatchObject({ color: "#ff0000", lw: 0.18 });
    // Linie, gestrichelte Linie, Fläche + Umriss (Hintergrund weggelassen), Text.
    const drawings = r.drawings;
    expect(drawings).toHaveLength(5);
    const line = drawings[0].geom;
    expect(line.shape).toBe("line");
    if (line.shape === "line") {
      expect(line.a.x).toBeCloseTo(72 * k, 9);
      expect(line.b.x - line.a.x).toBeCloseTo(3.527778, 5); // 100 pt = 35.28 mm Papier = 3.53 m bei 1:100
    }
    // Strichmuster → Linienstil: nur die gestrichelte Ebene bekommt eine lineStyleId.
    const styled = drawings.filter((d) => d.lineStyleId);
    expect(styled).toHaveLength(1);
    const style = r.project.lineStyles.find((l) => l.id === styled[0].lineStyleId);
    expect(style).toMatchObject({ name: "PDF-Strich 1.05/0.7 mm", dash: [1.05, 0.7] });
    expect(drawings.find((d) => d.fillColor)?.fillColor).toBe("#808080");
    const text = drawings.find((d) => d.geom.shape === "text")!;
    expect(text.geom).toMatchObject({ shape: "text", text: "Wohnen" });
    if (text.geom.shape === "text") expect(text.geom.height).toBeCloseTo(10 * k, 9);
    // Ohne Texte.
    expect(pdfImport(readPdfVector(makePdf(PLAN)), 100, { texts: false }).summary.texts).toBe(0);
  });

  it("vorhandener Linienstil mit gleichem Muster wird wiederverwendet", () => {
    const base = { ...emptyProject, lineStyles: [...emptyProject.lineStyles, { id: "eigen", name: "eigen", weight: 0.1, color: "#000", dash: [1.1, 0.7] }] };
    const r = importInto(base, pdfImport(readPdfVector(makePdf(PLAN)), 100));
    expect(r.project.lineStyles).toHaveLength(base.lineStyles.length);
    expect(r.drawings.filter((d) => d.lineStyleId === "eigen")).toHaveLength(1);
  });

  it("Rotate 90 dreht die Seite (Breite/Höhe getauscht)", () => {
    const page = readPdfVectorPage(makePdf("0 0 m 100 0 l S", "/Rotate 90"));
    expect([page.width, page.height]).toEqual([842, 595]);
    expect(page.paths[0].pts[1].x).toBeCloseTo(0, 9);
    expect(page.paths[0].pts[1].y).toBeCloseTo(495, 9);
  });

  it("kaputte und fremde Dateien werfen eine Meldung, das Modul bleibt benutzbar", () => {
    expect(() => readPdfVectorPage(new TextEncoder().encode("kein pdf"))).toThrow(/PDF/);
    const good = makePdf(PLAN);
    for (let cut = 0; cut < good.length; cut += 37) {
      try {
        readPdfVectorPage(good.subarray(0, cut));
      } catch {
        /* erwartet */
      }
    }
    expect(() => readPdfVectorPage(good, 5)).toThrow(/Seite 6/);
    expect(readPdfVectorPage(good).paths).toHaveLength(4);
    expect(isPdfFile("plan.PDF")).toBe(true);
    expect(isPdfFile("x.bin", good)).toBe(true);
    expect(isPdfFile("x.dxf")).toBe(false);
  });

  it("Kreis und Bogen aus Bézier-Folgen kommen als echte Kurven (Fang an Mitte/Quadrant)", () => {
    const k = 0.5522847498 * 40;
    const [cx, cy, r] = [200, 300, 40];
    const circle =
      `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ` +
      `${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ` +
      `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ` +
      `${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c h S `;
    const arc = `100 100 m 100 ${100 + k} ${60 + k} 140 60 140 c S`; // Viertelbogen um (60,100), r 40
    const page = readPdfVectorPage(makePdf(circle + arc));
    expect(page.paths).toHaveLength(2);
    expect(page.paths[0].curve).toMatchObject({ kind: "circle" });
    expect(page.paths[0].curve?.cx).toBeCloseTo(cx, 3);
    expect(page.paths[0].curve?.r).toBeCloseTo(r, 3);
    expect(page.paths[1].curve).toMatchObject({ kind: "arc" });
    expect(page.paths[1].curve?.a1).toBeCloseTo(Math.PI / 2, 3);

    const parsed = pdfImport(readPdfVector(makePdf(circle + arc)), 100);
    const m = pdfMetersPerPt(100);
    const contours = viewImport(parsed.src).contours[0].contours;
    expect(contours[0].curve).toMatchObject({ kind: "circle" });
    expect(contours[0].curve?.cx).toBeCloseTo(cx * m, 9);
    expect(contours[0].curve?.r).toBeCloseTo(r * m, 9);
    const drawings = importInto(emptyProject, parsed, { categoryMode: "active", activeCategoryCode: "00" }).drawings;
    expect(drawings[0].geom).toMatchObject({ shape: "circle" });
    expect(drawings[1].geom).toMatchObject({ shape: "arc" });
  });

  it("Strichmuster: Muster in Papier-mm je Ebene, Clip-Rechteck beschneidet", () => {
    const read = readPdfVector(makePdf("50 50 100 100 re W n 1 0 0 RG [8 4] 0 d 0 100 m 300 100 l S"));
    const page = read.page;
    expect(page.paths).toHaveLength(1);
    expect(page.paths[0].pts).toEqual([{ x: 50, y: 100 }, { x: 150, y: 100 }]);
    const res = viewImport(pdfImport(read, 50).src);
    const layer = Object.keys(res.layerDashes ?? {})[0];
    expect(layer).toMatch(/Strich 2\.8\/1\.4/);
    expect(res.layerDashes?.[layer]).toEqual([2.8, 1.4]);
  });
});
