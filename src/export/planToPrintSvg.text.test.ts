// Texte im Druck-SVG (Layout-Viewport, `planToPrintSvg`): Grösse in Papier-mm wie die Plan-Ansicht beim
// Massstab des Viewports — Einzeltexte (einfach und Rich-Text), Masszahlen, Höhenkoten, Raumstempel.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePlan } from "../plan/generatePlan";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories, type Project } from "../model/types";
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
  querySelector(s: string): El | null;
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
    querySelector(s) {
      for (const c of this.kids) {
        if (c.tag === s) return c;
        const r = c.querySelector(s);
        if (r) return r;
      }
      return null;
    },
    get firstChild() {
      return this.kids[0] ?? null;
    },
  };
}

const textOf = (e: El): string => e.textContent + e.kids.map(textOf).join("");

/** `<text>`-Knoten des SVG mit Inhalt und ihren Run-Grössen (mm) und Zeilen-y. */
function texts(svg: El): Array<{ text: string; sizes: number[]; ys: number[]; xs: number[] }> {
  return svg.kids
    .filter((k) => k.tag === "text")
    .map((t) => ({
      text: textOf(t),
      sizes: t.kids.flatMap((l) => l.kids.map((r) => Number(r.getAttribute("font-size")))),
      ys: t.kids.map((l) => Number(l.getAttribute("y"))),
      xs: t.kids.map((l) => Number(l.getAttribute("x"))),
    }));
}

const N = 50;
const K = 1000 / N; // Papier-mm je Meter

const project: Project = {
  ...sampleProject,
  drawings2d: [
    ...sampleProject.drawings2d,
    { id: "t1", type: "drawing2d", levelId: "eg", categoryCode: "60", geom: { shape: "text", at: { x: 1, y: 2 }, text: "Einzeltext", height: 0.3, angle: 0 } },
    {
      id: "t2",
      type: "drawing2d",
      levelId: "eg",
      categoryCode: "60",
      geom: {
        shape: "text",
        at: { x: 1, y: 1 },
        text: "Titel\nzweite Zeile",
        height: 0.2,
        angle: 0,
        width: 4,
        doc: {
          version: 1,
          paragraphs: [
            { runs: [{ text: "Titel", marks: { bold: true } }], align: "center" },
            { runs: [{ text: "zweite ", marks: {} }, { text: "Zeile", marks: { italic: true } }] },
          ],
        },
      },
    },
    { id: "d1", type: "drawing2d", levelId: "eg", categoryCode: "60", geom: { shape: "dimension", pts: [{ x: 0, y: -2 }, { x: 5, y: -2 }], offset: 0.5 } },
    { id: "k1", type: "drawing2d", levelId: "eg", categoryCode: "60", geom: { shape: "kote", at: { x: 6, y: 1 }, value: 0, kind: "okFertig", rotation: 0 } },
  ] as Project["drawings2d"],
};

describe("Druck-SVG: Textgrössen in Papier-mm", () => {
  let prev: unknown;
  beforeAll(() => {
    const g = globalThis as { document?: unknown };
    prev = g.document;
    g.document = { createElementNS: (_: string, tag: string) => el(tag) };
  });
  afterAll(() => {
    (globalThis as { document?: unknown }).document = prev;
  });

  const codes = new Set(flattenCategories(project.layers).map((c) => c.code));
  const print = () => {
    const plan = generatePlan(project, "eg", codes, undefined, "mittel", false, false, true, N);
    return texts(planToPrintSvg(plan, { scaleDenominator: N, pageWidthMm: 420, pageHeightMm: 297 }).svg as unknown as El);
  };

  it("Einzeltext: Höhe 0.3 m bei 1:50 = 6 mm", () => {
    const t = print().find((x) => x.text === "Einzeltext")!;
    expect(t.sizes).toEqual([0.3 * K]);
  });

  it("Rich-Text: Runs in Papier-mm, Zeilenvorschub 1.25 × Höhe, Mitte in der Spalte", () => {
    const t = print().find((x) => x.text.startsWith("Titel"))!;
    expect(t.sizes.every((s) => s === 0.2 * K)).toBe(true);
    expect(t.ys[1] - t.ys[0]).toBeCloseTo(0.2 * K * 1.25, 3);
    expect(t.xs[0] - t.xs[1]).toBeCloseTo((4 * K) / 2, 3);
  });

  it("Masszahl in der Papier-Schrifthöhe (4 mm), Höhenkote lesbar gross", () => {
    const all = print();
    const dim = all.find((x) => x.text === "5.00")!;
    expect(dim.sizes[0]).toBeCloseTo(4, 3);
    const kote = all.find((x) => /0[.,]00/.test(x.text) && x !== dim);
    expect(kote).toBeDefined();
    expect(kote!.sizes[0]).toBeGreaterThan(1);
  });

  it("Raumstempel im Viewport, Grösse in Papier-pt (10 pt)", () => {
    const stamp = print().find((x) => x.text.includes("Wohnen"))!;
    expect(stamp).toBeDefined();
    expect(stamp.sizes[0]).toBeCloseTo(10 * (25.4 / 72), 3);
  });
});
