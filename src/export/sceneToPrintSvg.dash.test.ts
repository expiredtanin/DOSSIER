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

// [169] Runde Stütze (in der Szene fein nachtesselliert) als Pfad mit Bögen statt Vieleck; gestrichelter
// Bogen (Türschwenk) mit Musterphase.
describe("Druck-SVG: Kreise und Bögen", () => {
  it("Kreis-Fläche und -Umriss als <path> mit A, Bogen mit stroke-dashoffset", () => {
    const ring: [number, number][] = Array.from({ length: 180 }, (_, i) => {
      const t = (2 * Math.PI * i) / 180;
      return [1 + 0.15 * Math.cos(t), 1 + 0.15 * Math.sin(t)];
    });
    const sc = {
      fills: [{ pts: ring, color: [0, 0, 0, 1], z: 0 }],
      outlines: [{ pts: ring, color: [0, 0, 0, 1], widthMm: 0.35, dash: null, z: 1 }],
      polylines: [],
      arcs: [{ center: [0, 0], from: [2, 0], to: [0, 2], r: 2, color: [0, 0, 0, 1], widthMm: 0.18, dash: [2, 1] }],
      lines: [],
      texts: [],
      images: [],
      bounds: { minX: -1, minY: -1, maxX: 3, maxY: 3 },
    } as unknown as RScene;
    const svg = sceneToPrintSvg(sc, { scaleDenominator: 50, pageWidthMm: 100, pageHeightMm: 100 }).svg as unknown as FakeEl;
    const paths = svg.children.filter((c) => c.tag === "path");
    expect(svg.children.some((c) => c.tag === "polygon")).toBe(false);
    // Fläche und Umriss (je zwei Halbkreise r = 3 mm bei 1:50) und der Bogen.
    expect(paths.filter((p) => (p.attrs.get("d") ?? "").includes(" A 3 3 ")).length).toBe(2);
    const arc = paths.find((p) => p.attrs.has("stroke-dasharray"))!;
    expect(arc.attrs.get("stroke-dashoffset")).toBeDefined();
  });

  it("Vollkreis: Muster auf ganze Wiederholungen über den Umfang, ohne Phase", () => {
    for (const n of [50, 100, 200]) {
      const r = (7.3 * n) / 1000; // 7.3 mm Radius auf dem Papier
      const pts: [number, number][] = [];
      for (let i = 0; i <= 96; i++) pts.push([r * Math.cos((2 * Math.PI * i) / 96), r * Math.sin((2 * Math.PI * i) / 96)]);
      const sc = { fills: [], outlines: [], polylines: [{ pts, color: [0, 0, 0, 1], widthMm: 0.18, dash: [2, 1], z: 0, widthScreen: false }], arcs: [], lines: [], texts: [], images: [], bounds: { minX: -r, minY: -r, maxX: r, maxY: r } } as unknown as RScene;
      const svg = sceneToPrintSvg(sc, { scaleDenominator: n, pageWidthMm: 100, pageHeightMm: 100 }).svg as unknown as FakeEl;
      const el = svg.children.find((c) => c.tag !== "defs" && c.attrs.has("stroke-dasharray"))!;
      const d = el.attrs.get("stroke-dasharray")!.split(" ").map(Number);
      const reps = (2 * Math.PI * 7.3) / (d[0] + d[1]);
      expect(Math.abs(reps - Math.round(reps))).toBeLessThan(0.02);
      expect(el.attrs.has("stroke-dashoffset")).toBe(false);
    }
  });
});
