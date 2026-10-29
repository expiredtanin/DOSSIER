// Blatt-Zeichnung im Layout-PDF: die Blatt-Ebene eines Layouts (`DrawingLevel.layoutId`, Papier 1:1 in
// Metern) liegt über `planToPrintSvg` mit festem Bereich genau auf dem Papier — Ursprung oben links,
// Strichstärken unverändert (auch mit `scaleLineWeights`), ohne weisses Blatt dahinter.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePlan } from "../plan/generatePlan";
import { sampleProject } from "../model/sampleProject";
import { collectVisibleCodes, type Project } from "../model/types";
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

const sheet = createSheetLevel("blatt", { id: "L1", name: "Blatt 1" });
const a = sheetMmToModel(10, 20);
const b = sheetMmToModel(110, 20);
const project: Project = {
  ...sampleProject,
  scaleLineWeights: true,
  drawingLevels: [...sampleProject.drawingLevels, sheet],
  drawings2d: [
    ...sampleProject.drawings2d,
    { id: "s1", type: "drawing2d", levelId: "blatt", categoryCode: "20", geom: { shape: "line", a, b }, weightMm: 0.5, color: "#ff0000" },
  ] as Project["drawings2d"],
};

describe("Druck-SVG der Blatt-Ebene", () => {
  let prev: unknown;
  beforeAll(() => {
    const g = globalThis as { document?: unknown };
    prev = g.document;
    g.document = { createElementNS: (_: string, tag: string) => el(tag) };
  });
  afterAll(() => {
    (globalThis as { document?: unknown }).document = prev;
  });

  it("liegt mm-genau auf dem Papier, Stärke 1:1, ohne weisses Blatt", () => {
    const plan = generatePlan(project, "blatt", collectVisibleCodes(project.layers), undefined, "fein", false, false, false, SHEET_SCALE_DENOMINATOR, true);
    // Nur die Blatt-Zeichnung: keine Wände des Geschosses, keine projektglobalen Zutaten.
    expect(plan.primitives.every((p) => !("wallId" in p && p.wallId))).toBe(true);
    const lo = sheetMmToModel(0, 297);
    const hi = sheetMmToModel(210, 0);
    const print = planToPrintSvg(plan, {
      scaleDenominator: SHEET_SCALE_DENOMINATOR,
      pageWidthMm: 210,
      pageHeightMm: 297,
      bounds: { minX: lo.x, minY: lo.y, maxX: hi.x, maxY: hi.y },
      transparent: true,
    });
    const svg = print.svg as unknown as El;
    expect(svg.kids.some((k) => k.tag === "rect" && k.getAttribute("fill") === "#ffffff")).toBe(false);
    const red = all(svg).filter((e) => e.getAttribute("stroke") === "#ff0000");
    expect(red.length).toBeGreaterThan(0);
    const geo = red.map((e) => e.getAttribute("points") ?? `${e.getAttribute("x1")},${e.getAttribute("y1")} ${e.getAttribute("x2")},${e.getAttribute("y2")}`).join(" ");
    const nums = geo.split(/[\s,]+/).map(Number);
    expect(nums).toHaveLength(4);
    [10, 20, 110, 20].forEach((v, i) => expect(nums[i]).toBeCloseTo(v, 6));
    expect(Number(red[0].getAttribute("stroke-width"))).toBeCloseTo(0.5, 9);
  });
});
