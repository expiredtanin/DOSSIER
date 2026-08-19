// Tests für wrapDocToLines: Wortumbruch auf feste Breite unter Erhalt der
// Run-Grenzen (gemischte Formatierung pro Zeile bleibt möglich).

import { describe, expect, it } from "vitest";
import { docFromText, makeRun, type RichTextDoc } from "./richText";
import { docToLines, wrapDocToLines } from "./renderHtml";

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
