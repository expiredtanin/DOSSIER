// Tests für wrapDocToLines: Wortumbruch auf feste Breite unter Erhalt der
// Run-Grenzen (gemischte Formatierung pro Zeile bleibt möglich).

import { describe, expect, it } from "vitest";
import { docFromText, makeRun, type RichTextDoc } from "./richText";
import { docToHtml, docToLines, runCssProps, wrapDocToLines } from "./renderHtml";

const OPTS = { x: 0, y: 0, lineHeight: 10, unitPerPt: 1, basePt: 10, color: "#000000" };

describe("wrapDocToLines", () => {
  it("ohne wrapWidthUnits identisch zu docToLines (eine Zeile je Absatz)", () => {
    const doc = docFromText("hallo welt");
    expect(wrapDocToLines(doc, OPTS)).toEqual(docToLines(doc, OPTS));
  });

  it("bricht lange Absätze wortweise auf mehrere Zeilen um", () => {
    const doc = docFromText("eins zwei drei vier fünf");
    const lines = wrapDocToLines(doc, { ...OPTS, wrapWidthUnits: 30 });
    expect(lines.length).toBeGreaterThan(1);
    const joined = lines.map((l) => l.tspans.map((t) => t.text).join("")).join(" ");
    expect(joined.replace(/\s+/g, " ").trim()).toBe("eins zwei drei vier fünf");
  });

  it("respektiert Run-Grenzen: ein fett formatiertes Wort bleibt in einem eigenen Tspan", () => {
    const doc: RichTextDoc = {
      version: 1,
      paragraphs: [
        {
          runs: [
            makeRun("normal ", {}),
            makeRun("fett", { bold: true }),
            makeRun(" weiter", {}),
          ],
        },
      ],
    };
    const lines = wrapDocToLines(doc, { ...OPTS, wrapWidthUnits: 1000 });
    expect(lines).toHaveLength(1);
    const boldTspan = lines[0].tspans.find((t) => t.text === "fett");
    expect(boldTspan?.fontWeight).toBe("700");
    const otherTspans = lines[0].tspans.filter((t) => t.text !== "fett");
    expect(otherTspans.every((t) => t.fontWeight === undefined)).toBe(true);
  });

  it("leerer Absatz erzeugt eine leere Zeile (Vorschub bleibt erhalten)", () => {
    const doc: RichTextDoc = { version: 1, paragraphs: [{ runs: [] }, { runs: [makeRun("x")] }] };
    const lines = wrapDocToLines(doc, { ...OPTS, wrapWidthUnits: 100 });
    expect(lines).toHaveLength(2);
    expect(lines[0].tspans).toHaveLength(0);
  });

  it("sehr schmale Breite bricht auf ein Wort je Zeile um, ohne Wörter zu verlieren", () => {
    const doc = docFromText("aa bb cc");
    const lines = wrapDocToLines(doc, { ...OPTS, wrapWidthUnits: 1 });
    const words = lines.map((l) => l.tspans.map((t) => t.text).join("").trim());
    expect(words).toEqual(["aa", "bb", "cc"]);
  });
});

// ── sizeUnit: "pt" (absolut, Dialog) vs. "em" (relativ, Zoom-Inline-Editoren) ──
// REGRESSION für "Editor ist immer unterschiedlich gross wie der Text": ohne
// "em" schrieb jeder Run eine ABSOLUTE pt-Grösse als Inline-Style, die die vom
// Container (PlanView/LayoutSheet, aus dem echten Zoom berechnet) geerbte
// Schriftgrösse ignorierte — der Text skalierte beim Zoomen nie mit.

describe("runCssProps — sizeUnit", () => {
  it("Default 'pt': absolute Grösse, unabhängig vom Container", () => {
    expect(runCssProps({}, 12)["font-size"]).toBe("12pt");
    expect(runCssProps({ sizePt: 18 }, 12)["font-size"]).toBe("18pt");
  });

  it("'em': Grösse relativ zu basePt — Runs OHNE eigene sizePt ergeben 1em", () => {
    expect(runCssProps({}, 12, "em")["font-size"]).toBe("1em");
    expect(runCssProps({ sizePt: 18 }, 12, "em")["font-size"]).toBe("1.5em");
    expect(runCssProps({ sizePt: 6 }, 12, "em")["font-size"]).toBe("0.5em");
  });

  it("'em' bei Hoch-/Tiefstellung skaliert wie 'pt' zusätzlich mit SCRIPT_SCALE (0.7)", () => {
    expect(runCssProps({ super: true }, 12, "em")["font-size"]).toBe("0.7em");
  });
});

describe("docToHtml — sizeUnit reicht bis in jeden Run-Span durch", () => {
  it("Default 'pt': jeder Span trägt eine absolute pt-Grösse", () => {
    const doc = docFromText("hallo");
    const html = docToHtml(doc, { basePt: 12 });
    expect(html).toContain("font-size:12pt");
  });

  it("'em': jeder Span trägt eine relative em-Grösse, KEINE absolute pt-Grösse", () => {
    const doc = docFromText("hallo");
    const html = docToHtml(doc, { basePt: 12, sizeUnit: "em" });
    expect(html).toContain("font-size:1em");
    expect(html).not.toContain("pt");
  });

  it("'em': ein Run mit eigener sizePt bleibt relativ zu basePt, nicht absolut", () => {
    const doc: RichTextDoc = {
      version: 1,
      paragraphs: [{ runs: [makeRun("Titel", { sizePt: 18 })] }],
    };
    const html = docToHtml(doc, { basePt: 12, sizeUnit: "em" });
    expect(html).toContain("font-size:1.5em");
  });
});
