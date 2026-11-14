// [208] Blatt-PDF: Bild eingebettet (JPEG ohne Neukompression), Plakat-Kopfzeile, anonyme Abgabe ohne Metadaten.
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Layout, Project } from "../model/types";
import { createPosterMaster, posterTemplate } from "../model/posterTemplates";
import { addImage, createLayoutImage } from "../model/layoutImages";
import { JPEG_64X48, PNG_40X30, PNG_40X30_ALPHA } from "../model/layoutImages.testing";
import { pdfVisibleText } from "./pdfText.testing";
import { buildPagesPdf, layoutPages, pdfBytes } from "./layoutPdf";
import { pdfInfoText } from "./pdfInfo";

const latin1 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

/** Alle Flate-Streams des PDF entpackt, hintereinander (Seiteninhalt ist komprimiert). */
function streamsText(bytes: Uint8Array): string {
  const all = Buffer.from(bytes);
  const text = all.toString("latin1");
  let out = "";
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const from = m.index! + m[0].length;
    const to = text.indexOf("endstream", from);
    try {
      out += inflateSync(all.subarray(from, to)).toString("latin1") + "\n";
    } catch {
      // kein Flate-Stream (z. B. JPEG)
    }
  }
  return out + "\n" + pdfVisibleText(bytes);
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function poster(extra?: Partial<Project>): Project {
  const master = createPosterMaster("m1", posterTemplate("poster-a1-landscape")!);
  master.titleBlock = { projectName: "Büro Muster AG", author: "Maria Muster" };
  const base: Layout = { id: "l1", name: "Grundriss", paper: "a1", orientation: "landscape", masterId: "m1", viewports: [] };
  const img = createLayoutImage("i1", "foto.jpg", JPEG_64X48, { w: 841, h: 594 })!;
  return { ...sampleProject, name: "Haus Muster", masterLayouts: [master], layouts: [addImage(base, img)], ...extra };
}

describe("Blatt-PDF mit Bild", () => {
  it("bettet das JPEG unverändert ein (DCTDecode, keine Neukompression)", async () => {
    const p = poster();
    const doc = await buildPagesPdf(p, layoutPages(p, ["l1"]));
    const bytes = pdfBytes(p, doc!);
    expect(latin1(bytes)).toContain("/DCTDecode");
    expect(indexOfBytes(bytes, JPEG_64X48)).toBeGreaterThan(0);
  });

  it("PNG mit und ohne Alpha lässt sich einbetten", async () => {
    for (const png of [PNG_40X30, PNG_40X30_ALPHA]) {
      const p = poster();
      const img = createLayoutImage("i2", "r.png", png, { w: 841, h: 594 })!;
      p.layouts = [addImage({ ...p.layouts![0], images: [] }, img)];
      const doc = await buildPagesPdf(p, layoutPages(p, ["l1"]));
      expect(latin1(pdfBytes(p, doc!))).toContain("/Subtype /Image");
    }
  });

  it("Blattgrösse A1 quer, Plakat-Kopfzeile mit Kennwort und Plan x/n", async () => {
    const p = poster({ competition: { anonymous: false, keyword: "FALKE 7" } });
    const doc = await buildPagesPdf(p, layoutPages(p, ["l1"]));
    const bytes = pdfBytes(p, doc!);
    expect(latin1(bytes)).toMatch(/\/MediaBox \[0 0 2383\.93\d* 1683\.7\d*/); // 841 × 594 mm in pt
    const content = streamsText(bytes);
    expect(content).toContain("Kennwort");
    expect(content).toContain("FALKE 7");
    expect(content).toContain("Plan 1/1");
  });

  it("anonyme Abgabe: keine Büro-/Autor-Angaben, Info nur mit Kennwort, kein jsPDF-Producer", async () => {
    const p = poster({ competition: { anonymous: true, keyword: "FALKE 7" } });
    const doc = await buildPagesPdf(p, layoutPages(p, ["l1"]));
    const bytes = pdfBytes(p, doc!);
    const info = pdfInfoText(bytes);
    expect(info).toContain("/Title (FALKE 7)");
    expect(info).not.toMatch(/jsPDF/);
    expect(info).not.toContain("/Author");
    expect(info).not.toContain("/Creator");
    expect(info).toContain("D:20000101000000");
    const all = latin1(bytes) + streamsText(bytes);
    expect(all).not.toContain("Büro Muster");
    expect(all).not.toContain("Maria Muster");
    expect(all).not.toContain("Haus Muster");
    expect(all).toContain("FALKE 7");
  });

  it("nicht anonym: Projektname im Titel, Bearbeiter im Info-Wörterbuch", async () => {
    const p = poster();
    const doc = await buildPagesPdf(p, layoutPages(p, ["l1"]));
    const info = pdfInfoText(pdfBytes(p, doc!));
    expect(info).toContain("/Title (Haus Muster)");
    expect(info).toContain("Maria Muster");
  });
});
