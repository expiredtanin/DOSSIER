// [153] PDF-Druck-SVG: Strichmuster in Papier-mm, in jedem Massstab gleich lang, Musterphase vom Kern
// (`plan::line_pattern::phase`): beide Enden einer gestrichelten Linie auf einem Strich.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sceneToPrintSvg } from "./sceneToPrintSvg";
import type { RScene } from "../plan/toRenderScene";

/** Kleinst-DOM (die Testumgebung ist `node`): Elemente mit Attributen und Kindern. */
class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  textContent = "";
  constructor(public tag: string) {}
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
}

const g = globalThis as { document?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.document;
  g.document = { createElementNS: (_ns: string, tag: string) => new FakeEl(tag) };
});
afterEach(() => {
  g.document = saved;
});

/** Eine gestrichelte Linie, die bei 1:`n` auf dem Papier 30 mm lang ist. */
function scene(n: number): RScene {
  const len = (30 * n) / 1000;
  return {
    fills: [],
    outlines: [],
    polylines: [],
    arcs: [],
    lines: [{ a: [0, 0], b: [len, 0], color: [0, 0, 0, 1], widthMm: 0.18, dash: [2, 1], z: 0 }],
    texts: [],
    images: [],
    bounds: { minX: 0, minY: -1, maxX: len, maxY: 1 },
  } as RScene;
}

describe("Druck-SVG: Strichmuster", () => {
  it("gleiche Musterlänge und Phase in 1:50, 1:100, 1:200", () => {
    const seen = [50, 100, 200].map((n) => {
      const svg = sceneToPrintSvg(scene(n), { scaleDenominator: n, pageWidthMm: 100, pageHeightMm: 100 }).svg as unknown as FakeEl;
      const line = svg.children.find((c) => c.tag === "line")!;
      return [line.attrs.get("stroke-dasharray"), line.attrs.get("stroke-dashoffset")];
    });
    expect(seen.every((s) => s[0] === "2 1")).toBe(true);
    // 30 mm mit [2, 1]: genau 10 Zyklen → Phase so, dass das Ende auf einem Strich liegt (nicht 0).
    expect(seen[0][1]).toBeDefined();
    expect(seen.every((s) => s[1] === seen[0][1])).toBe(true);
  });
});
