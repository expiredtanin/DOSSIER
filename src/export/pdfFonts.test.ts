// [208] PDF-Schriften: Inter und die gewählten Familien sind eingebettet (`pdffonts`: emb yes), Umlaute und
// Sonderzeichen kommen im Text an (`pdftotext`). Ohne Poppler-Werkzeuge laufen nur die Prüfungen ohne sie.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Layout, Project } from "../model/types";
import { createPosterMaster, posterTemplate } from "../model/posterTemplates";
import { buildAreaReport, buildAreaReportPdf } from "./areaReport";
import { buildPagesPdf, layoutPages, pdfBytes } from "./layoutPdf";
import { ensurePdfFonts, prepareSvgFonts, resolvePdfFamily, setPdfFont, setPdfFontLoader } from "./pdfFonts";
import { HAVE_POPPLER, pdfVisibleText, withPdfFile } from "./pdfText.testing";

const SPECIAL = "Größe Ø 12 ± 3 m² m³ – „Bürgenstock“ ß Äöü";
const EMB = /\byes\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/; // Spalte „emb“ = yes

const fonts = (bytes: Uint8Array) => withPdfFile(bytes, (f) => spawnSync("pdffonts", [f], { encoding: "utf8" }).stdout.split("\n").slice(2).filter(Boolean));
const fromDisk = async (url: string) => (existsSync(`public${url}`) ? new Uint8Array(readFileSync(`public${url}`)) : null);

describe("resolvePdfFamily", () => {
  it("erste gebündelte Familie der CSS-Liste, sonst Inter", () => {
    expect(resolvePdfFamily("Helvetica, Arial, sans-serif")).toBe("Inter");
    expect(resolvePdfFamily('"IBM Plex Mono", monospace')).toBe("IBM Plex Mono");
    expect(resolvePdfFamily("arial, work sans")).toBe("Work Sans");
    expect(resolvePdfFamily("serif")).toBe("Source Serif 4");
    expect(resolvePdfFamily(null)).toBe("Inter");
  });
});

describe("PDF-Schriften", () => {
  it("jsPDF kennt die eingebetteten Schnitte; ohne Lader bleibt Helvetica", async () => {
    const doc = new jsPDF();
    await ensurePdfFonts(doc, ["Inter", "Source Serif 4"]);
    const list = doc.getFontList();
    expect(list["Inter"]).toEqual(expect.arrayContaining(["normal", "bold", "italic", "bolditalic"]));
    expect(list["Source Serif 4"]).toBeDefined();
    setPdfFontLoader(async () => null);
    try {
      const bare = new jsPDF();
      await ensurePdfFonts(bare, ["Inter"]);
      setPdfFont(bare, "Inter", true);
      expect(bare.getFont().fontName).toBe("helvetica");
    } finally {
      setPdfFontLoader(fromDisk);
    }
  });

  it("prepareSvgFonts ersetzt die font-family-Listen durch die gebündelte Familie", async () => {
    const doc = new jsPDF();
    const fake = (family: string | null) => {
      const attrs = new Map<string, string>(family === null ? [] : [["font-family", family]]);
      return {
        getAttribute: (n: string) => attrs.get(n) ?? null,
        setAttribute: (n: string, v: string) => void attrs.set(n, v),
        hasAttribute: (n: string) => attrs.has(n),
        querySelectorAll: () => kids,
      };
    };
    const kids = [fake("Helvetica, Arial, sans-serif"), fake("Work Sans, sans-serif")];
    const root = fake(null);
    await prepareSvgFonts(doc, root as unknown as Element);
    expect(kids.map((k) => k.getAttribute("font-family"))).toEqual(["Inter", "Work Sans"]);
    expect(root.getAttribute("font-family")).toBe("Inter");
  });

  it.runIf(HAVE_POPPLER)("Bericht-PDF: Schrift eingebettet, Sonderzeichen im Text", async () => {
    const report = buildAreaReport(sampleProject, { areas: true });
    report.title = SPECIAL;
    const doc = await buildAreaReportPdf(report);
    const bytes = new Uint8Array(doc.output("arraybuffer"));
    const rows = fonts(bytes);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatch(EMB);
    expect(rows.join("\n")).toMatch(/Inter/);
    expect(rows.join("\n")).not.toMatch(/Helvetica|Times|Courier/);
    expect(pdfVisibleText(bytes).replace(/\s+/g, " ")).toContain(SPECIAL);
  });

  it.runIf(HAVE_POPPLER)("Blatt-PDF: Plakat-Kopfzeile in Inter, Sonderzeichen im Text", async () => {
    const master = createPosterMaster("m1", posterTemplate("poster-a1-landscape")!);
    master.titleBlock = { projectName: SPECIAL, author: "Zoë Müller" };
    const lay: Layout = { id: "l1", name: "Grundriss", paper: "a1", orientation: "landscape", masterId: "m1", viewports: [] };
    const p: Project = { ...sampleProject, name: "Haus", masterLayouts: [master], layouts: [lay] };
    const doc = await buildPagesPdf(p, layoutPages(p, ["l1"]));
    const bytes = pdfBytes(p, doc!);
    const rows = fonts(bytes);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatch(EMB);
    expect(rows.join("\n")).not.toMatch(/Helvetica|Times|Courier/);
    // Ø, ², ³, ±, –, „“, ß und Umlaute müssen unversehrt ankommen.
    expect(pdfVisibleText(bytes).replace(/\s+/g, " ")).toContain(SPECIAL);
  });
});
