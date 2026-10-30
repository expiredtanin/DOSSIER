// [80] PDF-Ebenen (Optional Content): Ebenen im Katalog, Inhalt in /OC-Marken, gleiche Namen = eine Ebene.

import { describe, expect, it } from "vitest";
import { jsPDF } from "jspdf";
import { categoryLayerGroups, enablePdfLayers } from "./pdfLayers";
import type { LayerCategory } from "../model/types";

const text = (doc: jsPDF) => Buffer.from(doc.output("arraybuffer")).toString("latin1");
const utf16Hex = (s: string) => "FEFF" + [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("").toUpperCase();

describe("enablePdfLayers", () => {
  it("schreibt OCProperties, OCGs mit Namen und markiert den Inhalt", async () => {
    const doc = new jsPDF({ unit: "mm", compress: false });
    const layers = enablePdfLayers(doc);
    await layers.run("Wände", () => doc.rect(10, 10, 20, 20));
    doc.addPage();
    await layers.run("Wände", () => doc.rect(10, 10, 5, 5));
    await layers.run("Möbel", () => doc.line(0, 0, 10, 10));
    doc.rect(1, 1, 1, 1); // ausserhalb jeder Ebene
    const s = text(doc);
    expect(s).toContain("/OCProperties");
    expect(s.match(/\/Type \/OCG/g)?.length).toBe(2); // „Wände" gemeinsam auf beiden Seiten
    expect(s).toContain(`/Name <${utf16Hex("Wände")}>`);
    expect(s).toContain(`/Name <${utf16Hex("Möbel")}>`);
    expect(s.match(/\/OC \/\w+ BDC/g)?.length).toBe(3);
    expect(s.match(/\bEMC\b/g)?.length).toBe(3);
    expect(s).toContain("/Properties <<");
    expect(layers.names()).toEqual(["Wände", "Möbel"]);
  });

  it("ohne benutzte Ebene bleibt das PDF unverändert (kein OCProperties)", () => {
    const doc = new jsPDF({ unit: "mm", compress: false });
    enablePdfLayers(doc);
    doc.rect(1, 1, 1, 1);
    expect(text(doc)).not.toContain("OCProperties");
  });

  it("Marken sind auch bei werfendem Inhalt ausgeglichen", async () => {
    const doc = new jsPDF({ unit: "mm", compress: false });
    const layers = enablePdfLayers(doc);
    await expect(layers.run("A", () => { throw new Error("x"); })).rejects.toThrow();
    expect(text(doc).match(/\/OC \/\w+ BDC/g)?.length).toBe(text(doc).match(/\bEMC\b/g)?.length);
  });
});

describe("categoryLayerGroups", () => {
  const cat = (code: string, name: string, children?: LayerCategory[]) => ({ code, name, children }) as LayerCategory;
  it("eine Gruppe je Wurzel mit sichtbaren Unterkategorien; Verwaistes in „Übrige“; Leeres entfällt", () => {
    const tree = [cat("1", "Bau", [cat("11", "Wände"), cat("12", "Decken")]), cat("2", "Möbel"), cat("3", "Leer")];
    const g = categoryLayerGroups(tree, new Set(["11", "2", "99"]), "Übrige");
    expect(g.map((x) => [x.name, [...x.codes]])).toEqual([["Bau", ["11"]], ["Möbel", ["2"]], ["Übrige", ["99"]]]);
  });
});
