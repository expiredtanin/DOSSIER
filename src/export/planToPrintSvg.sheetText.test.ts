// [208] Freie Textspalte auf dem Blatt im Druck-SVG (Quelle des Blatt-PDFs und -SVGs): Rich-Text auf der Blatt-Ebene
// (Papier 1:1), Schrift/Grösse/Fett je Run, Umbruch in der Rahmenbreite, Blocksatz als Wörter an festen x-Lagen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePlan } from "../plan/generatePlan";
import { sampleProject } from "../model/sampleProject";
import { collectVisibleCodes, type Project, type RichTextDoc } from "../model/types";
import { createSheetLevel, sheetMmToModel, SHEET_SCALE_DENOMINATOR } from "../model/layoutModel";
import { planToPrintSvg } from "./planToPrintSvg";

interface El {
  tag: string;
  attrs: Map<string, string>;
  kids: El[];
  textContent: string;
  setAttribute(k: string, v: unknown): void;
  getAttribute(k: string): string | null;
  appendChild(c: El): El;
  insertBefore(n: El, r: El | null): El;
  readonly firstChild: El | null;
}

function el(tag: string): El {
  return {
    tag,
    attrs: new Map(),
    kids: [],
    textContent: "",
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    },
    getAttribute(k) {
      return this.attrs.get(k) ?? null;
    },
    appendChild(c) {
      this.kids.push(c);
      return c;
    },
    insertBefore(n) {
      this.kids.unshift(n);
      return n;
    },
    get firstChild() {
      return this.kids[0] ?? null;
    },
  };
}

const all = (e: El): El[] => [e, ...e.kids.flatMap(all)];

const SATZ = "Der Hof öffnet sich nach Süden und verbindet die beiden Häuser mit dem Dorfplatz und dem Bach.";
const X_MM = 60;
const WIDTH_MM = 120;

function project(align: "left" | "justify"): Project {
  const sheet = createSheetLevel("blatt", { id: "L1", name: "Blatt 1" });
  const doc: RichTextDoc = {
    version: 1,
    paragraphs: [
      { runs: [{ text: SATZ, marks: { font: "Work Sans", sizePt: 24 } }], align },
      { runs: [{ text: "Zweiter ", marks: { font: "Work Sans", sizePt: 24 } }, { text: "Absatz", marks: { font: "Work Sans", sizePt: 24, bold: true, italic: true, color: "#cc0000" } }], align: "right" },
    ],
  };
  return {
    ...sampleProject,
    drawingLevels: [...sampleProject.drawingLevels, sheet],
    drawings2d: [
      ...sampleProject.drawings2d,
      { id: "txt1", type: "drawing2d", levelId: "blatt", categoryCode: "20", geom: { shape: "text", at: sheetMmToModel(X_MM, 100), text: "", height: 0.0085, angle: 0, width: WIDTH_MM / 1000, doc } },
    ] as Project["drawings2d"],
  };
}

function textTspans(p: Project): El[] {
  const plan = generatePlan(p, "blatt", collectVisibleCodes(p.layers), undefined, "fein", false, false, false, SHEET_SCALE_DENOMINATOR, true);
  const lo = sheetMmToModel(0, 594);
  const hi = sheetMmToModel(841, 0);
  const print = planToPrintSvg(plan, { scaleDenominator: SHEET_SCALE_DENOMINATOR, pageWidthMm: 841, pageHeightMm: 594, bounds: { minX: lo.x, minY: lo.y, maxX: hi.x, maxY: hi.y }, transparent: true });
  return all(print.svg as unknown as El).filter((e) => e.tag === "tspan");
}

describe("Textspalte im Druck-SVG des Blatts", () => {
  let prev: unknown;
  beforeAll(() => {
    const g = globalThis as { document?: unknown };
    prev = g.document;
    g.document = { createElementNS: (_: string, tag: string) => el(tag) };
  });
  afterAll(() => {
    (globalThis as { document?: unknown }).document = prev;
  });

  it("umbricht in der Rahmenbreite; Schrift, Fett/Kursiv und Farbe je Run; rechtsbündiger Absatz in der Spalte", () => {
    const ts = textTspans(project("left"));
    const lines = ts.filter((t) => t.getAttribute("x") !== null && t.getAttribute("text-anchor") !== null);
    // Erster Absatz: mehrere Zeilen, alle am linken Rand; zweiter Absatz rechtsbündig am rechten Spaltenrand.
    const ys = [...new Set(lines.map((l) => l.getAttribute("y")))];
    expect(ys.length).toBeGreaterThanOrEqual(4);
    const starts = lines.filter((l) => l.getAttribute("text-anchor") === "start");
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const l of starts) expect(Number(l.getAttribute("x"))).toBeCloseTo(X_MM, 3);
    const ends = lines.filter((l) => l.getAttribute("text-anchor") === "end");
    expect(ends).toHaveLength(1);
    expect(Number(ends[0].getAttribute("x"))).toBeCloseTo(X_MM + WIDTH_MM, 3);
    const runs = ts.filter((t) => t.getAttribute("font-family") === "Work Sans");
    expect(runs.length).toBeGreaterThan(3);
    expect(runs.every((r) => Number(r.getAttribute("font-size")) > 8 && Number(r.getAttribute("font-size")) < 9)).toBe(true); // 24 pt = 8.47 mm
    const bold = runs.find((r) => r.getAttribute("font-weight") === "700")!;
    expect(bold.getAttribute("font-style")).toBe("italic");
    expect(bold.getAttribute("fill")).toBe("#cc0000");
  });

  it("Blocksatz: jedes Wort an eigener x-Lage, erstes Wort jeder Zeile am Rand, mehr Stücke als bei linksbündig", () => {
    const left = textTspans(project("left")).filter((t) => t.getAttribute("text-anchor") === "start");
    const just = textTspans(project("justify")).filter((t) => t.getAttribute("text-anchor") === "start");
    expect(just.length).toBeGreaterThan(left.length + 5);
    const xs = just.map((t) => Number(t.getAttribute("x")));
    expect(Math.min(...xs)).toBeCloseTo(X_MM, 3);
    expect(Math.max(...xs)).toBeGreaterThan(X_MM + WIDTH_MM * 0.6);
    expect(Math.max(...xs)).toBeLessThan(X_MM + WIDTH_MM);
    // Je Wort ein Stück: der Text ist vollständig.
    const words = just.map((t) => t.kids.map((k) => k.textContent).join("") || t.textContent);
    expect(words.join(" ")).toContain("Dorfplatz");
  });
});
