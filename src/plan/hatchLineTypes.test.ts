// Phase-C-Rendering der NEUEN Schraffur-/Linien-Typen (Bild-Schraffur,
// Random-Vektor, Zickzack-Linie). Prüft die drei Darstellungen an den SVG-nahen
// Pfaden (planToRenderScene = Live/WASM/PDF-Quelle, planToPrintSvg = Print) sowie
// die geteilten Geometrie-Helfer. Der Default-Sample bleibt unberührt.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plan, Primitive, HatchRender } from "./generatePlan";
import { planToRenderScene } from "./toRenderScene";
import { buildHatchRuns, buildRandomHatchRuns, zigzagPoints, motifPoints } from "./glPlan/glPlanHatch";

const SQUARE = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 0, y: 4 },
];

function hatch(over: Partial<HatchRender> = {}): HatchRender {
  return {
    pattern: "diagonal",
    scale: 1,
    angle: 0,
    color: "#123456",
    lineWeight: 0.13,
    dash: null,
    ...over,
  };
}

function planOf(prims: Primitive[]): Plan {
  return { primitives: prims, bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 } };
}

describe("zigzagPoints", () => {
  it("erzeugt einen Zickzack-Pfad mit alternierender Auslenkung", () => {
    const pts = zigzagPoints({ x: 0, y: 0 }, { x: 8, y: 0 }, 1, 4);
    // Mehr Stützpunkte als die reine Gerade (Zickzack), und quer ausgelenkt.
    expect(pts.length).toBeGreaterThan(3);
    const ys = pts.map((p) => p.y);
    expect(Math.max(...ys)).toBeGreaterThan(0.5); // +A
    expect(Math.min(...ys)).toBeLessThan(-0.5); // -A
    // Beginnt auf der Achse, endet exakt auf b.
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(8, 6);
    expect(pts[pts.length - 1].y).toBeCloseTo(0, 6);
  });

  it("degeneriert (amplitude 0 / wavelength 0) auf die Gerade", () => {
    expect(zigzagPoints({ x: 0, y: 0 }, { x: 1, y: 0 }, 0, 4)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
  });
});

describe("motifPoints (Custom-Wiederhol-Motiv)", () => {
  // Dreieckszelle (0..4 entlang, ±1 quer): loopt entlang der Linie.
  const MOTIF = {
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
      { x: 3, y: -1 },
      { x: 4, y: 0 },
    ],
    length: 4,
  };

  it("kachelt das Motiv entlang der Strecke (mehr Stützpunkte, quer ausgelenkt)", () => {
    const pts = motifPoints({ x: 0, y: 0 }, { x: 12, y: 0 }, MOTIF);
    expect(pts.length).toBeGreaterThan(5); // mehrere Kacheln
    const ys = pts.map((p) => p.y);
    expect(Math.max(...ys)).toBeGreaterThan(0.5); // +Ausschlag
    expect(Math.min(...ys)).toBeLessThan(-0.5); // −Ausschlag
    // Endet nicht über b hinaus (auf L geclippt).
    expect(Math.max(...pts.map((p) => p.x))).toBeLessThanOrEqual(12 + 1e-6);
  });

  it("skaliert Punkte UND Länge (scale) und legt sie auf die Normale", () => {
    // Vertikale Linie, scale 0.5: y-Versatz wandert in x-Richtung (linke Normale).
    const pts = motifPoints({ x: 0, y: 0 }, { x: 0, y: 8 }, MOTIF, 0.5);
    // Bei einer Linie in +y ist die linke Normale (−1, 0): +y-Motiv → −x.
    expect(Math.min(...pts.map((p) => p.x))).toBeLessThan(-0.1);
  });

  it("degeneriert (leeres Motiv / Länge 0 / Nullstrecke) auf die Gerade", () => {
    expect(motifPoints({ x: 0, y: 0 }, { x: 4, y: 0 }, { points: [{ x: 0, y: 0 }], length: 4 })).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]);
    expect(motifPoints({ x: 0, y: 0 }, { x: 4, y: 0 }, { points: MOTIF.points, length: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]);
  });
});

describe("Random-Vektor-Schraffur", () => {
  it("liefert Streu-Striche (nicht leer) und ist DETERMINISTISCH bei gleichem Seed", () => {
    const h = hatch({ kind: "vector", lines: "random", scale: 1 });
    const a = buildHatchRuns(SQUARE, h);
    const b = buildHatchRuns(SQUARE, h);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b); // identische Geometrie bei identischen Eingaben
  });

  it("unterscheidet sich von der regelmäßigen Parallelschar", () => {
    const random = buildHatchRuns(SQUARE, hatch({ kind: "vector", lines: "random" }));
    const parallel = buildHatchRuns(SQUARE, hatch({ lines: "parallel" }));
    expect(JSON.stringify(random)).not.toEqual(JSON.stringify(parallel));
  });

  it("expliziter Seed ist reproduzierbar und aendert die Streuung (Neu wuerfeln)", () => {
    const base = { kind: "vector", lines: "random", scale: 1 } as const;
    const s7a = buildHatchRuns(SQUARE, hatch({ ...base, seed: 7 }));
    const s7b = buildHatchRuns(SQUARE, hatch({ ...base, seed: 7 }));
    const s8 = buildHatchRuns(SQUARE, hatch({ ...base, seed: 8 }));
    expect(s7a).toEqual(s7b); // gleicher Seed ⇒ identische Geometrie
    expect(JSON.stringify(s7a)).not.toEqual(JSON.stringify(s8)); // neuer Seed ⇒ neue Streuung
  });

  it("Dichte verdichtet die Streuung, Längenspanne wird angewandt", () => {
    const base = { kind: "vector", lines: "random", scale: 1, seed: 3 } as const;
    const sparse = buildHatchRuns(SQUARE, hatch({ ...base }));
    const dense = buildHatchRuns(SQUARE, hatch({ ...base, density: 3 }));
    expect(dense.length).toBeGreaterThan(sparse.length);
    // Längenspanne greift ohne zu werfen und bleibt deterministisch.
    const ranged = buildHatchRuns(SQUARE, hatch({ ...base, lengthMin: 1, lengthMax: 2 }));
    expect(ranged).toEqual(buildHatchRuns(SQUARE, hatch({ ...base, lengthMin: 1, lengthMax: 2 })));
  });

  it("ist MODELLRAUM-VERANKERT: grössere Fläche enthält die Striche der kleineren unverändert", () => {
    // Zwei konzentrische Quadrate; das grosse enthält das kleine mit Rand ≥ 4 m.
    const small = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    const big = [
      { x: -4, y: -4 },
      { x: 8, y: -4 },
      { x: 8, y: 8 },
      { x: -4, y: 8 },
    ];
    const h = hatch({ kind: "vector", lines: "random", scale: 1, seed: 5 });
    const rsSmall = buildRandomHatchRuns(small, h);
    const rsBig = buildRandomHatchRuns(big, h);
    expect(rsSmall.length).toBeGreaterThan(0);
    const key = (r: { x: number; y: number }[]) => JSON.stringify(r);
    const bigSet = new Set(rsBig.map(key));
    // Striche des kleinen Quadrats, die STRIKT im Inneren liegen (Clipping hat sie
    // nicht bewegt), müssen im grossen Quadrat identisch wieder auftauchen —
    // gleiche Zelle ⇒ gleicher Strich. So bleibt beim Vergrössern nichts stehen-los.
    const interior = rsSmall.filter((run) =>
      run.every((p) => p.x > 0.05 && p.x < 3.95 && p.y > 0.05 && p.y < 3.95),
    );
    expect(interior.length).toBeGreaterThan(0);
    for (const run of interior) {
      expect(bigSet.has(key(run))).toBe(true);
    }
  });

  it("bleibt beim VERSCHIEBEN der Fläche gleich dicht (Striche pro Fläche konstant)", () => {
    const sq = (ox: number, oy: number) => [
      { x: ox, y: oy },
      { x: ox + 6, y: oy },
      { x: ox + 6, y: oy + 6 },
      { x: ox, y: oy + 6 },
    ];
    const h = hatch({ kind: "vector", lines: "random", scale: 1, seed: 2 });
    const a = buildRandomHatchRuns(sq(0, 0), h).length;
    const b = buildRandomHatchRuns(sq(37, -19), h).length;
    // Gleiche Fläche an anderer Stelle ⇒ näherungsweise gleiche Strichzahl (Dichte
    // konstant; ±1 Reihe Rand-Toleranz durch die Zell-Ausrichtung).
    expect(Math.abs(a - b)).toBeLessThan(a * 0.25 + 5);
  });

  it("erscheint als Streu-Polylinien in der RenderScene (deterministisch)", () => {
    const poly: Primitive = {
      kind: "polygon",
      pts: SQUARE,
      fill: "#ffffff",
      stroke: "none",
      strokeWidthMm: 0,
      hatch: hatch({ kind: "vector", lines: "random" }),
    };
    const s1 = planToRenderScene(planOf([poly]));
    const s2 = planToRenderScene(planOf([poly]));
    expect(s1.polylines.length).toBeGreaterThan(0);
    expect(s1.polylines).toEqual(s2.polylines);
  });
});

describe("Zickzack-Linie in der RenderScene", () => {
  it("emittiert eine tessellierte Polylinie statt einer geraden Linie", () => {
    const line: Primitive = {
      kind: "line",
      a: { x: 0, y: 0 },
      b: { x: 4, y: 0 },
      cls: "draw2d",
      weightMm: 0.18,
      zigzag: { amplitude: 2, wavelength: 4 },
    };
    const scene = planToRenderScene(planOf([line]));
    expect(scene.lines.length).toBe(0); // KEINE gerade Linie
    expect(scene.polylines.length).toBe(1);
    expect(scene.polylines[0].pts.length).toBeGreaterThan(3); // Zickzack
  });
});

describe("Bild-Schraffur — Fallback in der (texturlosen) RenderScene", () => {
  it("erzeugt KEINE Musterlinien (nur neutrale Füllung)", () => {
    const poly: Primitive = {
      kind: "polygon",
      pts: SQUARE,
      fill: "#eeeeee",
      stroke: "none",
      strokeWidthMm: 0,
      hatch: hatch({
        kind: "image",
        pattern: "diagonal", // würde OHNE image-Fallback Diagonalen zeichnen
        image: { src: "data:image/png;base64,AAAA", scaleX: 1, scaleY: 1, rotation: 0 },
      }),
    };
    const scene = planToRenderScene(planOf([poly]));
    expect(scene.polylines.length).toBe(0); // Fallback: keine Vektor-Musterlinien
    expect(scene.fills.length).toBe(1); // neutrale Poché-Füllung bleibt
  });
});

// ── Print-SVG (planToPrintSvg): Bild-<pattern>/<image> + Zickzack-<polyline> ──
// Node-Umgebung ohne DOM → minimaler document-Stub (nur die von planToPrintSvg
// genutzten Methoden). So lässt sich der erzeugte SVG-Knotenbaum inspizieren.

interface StubEl {
  tagName: string;
  attrs: Map<string, string>;
  childNodes: StubEl[];
  setAttribute(k: string, v: unknown): void;
  getAttribute(k: string): string | null;
  appendChild(c: StubEl): StubEl;
  insertBefore(n: StubEl, ref: StubEl | null): StubEl;
  querySelector(sel: string): StubEl | null;
  readonly firstChild: StubEl | null;
}

function makeEl(tag: string): StubEl {
  const el: StubEl = {
    tagName: tag,
    attrs: new Map(),
    childNodes: [],
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    },
    getAttribute(k) {
      return this.attrs.get(k) ?? null;
    },
    appendChild(c) {
      this.childNodes.push(c);
      return c;
    },
    insertBefore(n, ref) {
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.unshift(n);
      else this.childNodes.splice(i, 0, n);
      return n;
    },
    querySelector(sel) {
      for (const c of this.childNodes) {
        if (c.tagName === sel) return c;
        const r = c.querySelector(sel);
        if (r) return r;
      }
      return null;
    },
    get firstChild() {
      return this.childNodes[0] ?? null;
    },
  };
  return el;
}

function walk(el: StubEl, pred: (e: StubEl) => boolean, acc: StubEl[] = []): StubEl[] {
  if (pred(el)) acc.push(el);
  for (const c of el.childNodes) walk(c, pred, acc);
  return acc;
}

describe("planToPrintSvg — neue Typen", () => {
  let prevDoc: unknown;
  beforeAll(() => {
    prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document: unknown }).document = {
      createElementNS: (_ns: string, tag: string) => makeEl(tag),
    };
  });
  afterAll(() => {
    (globalThis as { document?: unknown }).document = prevDoc;
  });

  it("Bild-Schraffur ⇒ <pattern> mit gekacheltem <image>, Zickzack ⇒ <polyline>", async () => {
    const { planToPrintSvg } = await import("../export/planToPrintSvg");
    const imgPoly: Primitive = {
      kind: "polygon",
      pts: SQUARE,
      fill: "none",
      stroke: "#111111",
      strokeWidthMm: 0.25,
      hatch: hatch({
        kind: "image",
        image: { src: "data:image/png;base64,ZZZ", scaleX: 2, scaleY: 0.5, rotation: 30 },
      }),
    };
    const zline: Primitive = {
      kind: "line",
      a: { x: 0, y: 0 },
      b: { x: 4, y: 0 },
      cls: "draw2d",
      weightMm: 0.18,
      zigzag: { amplitude: 1, wavelength: 4 },
    };
    const { svg } = planToPrintSvg(planOf([imgPoly, zline]), {
      scaleDenominator: 100,
      pageWidthMm: 210,
      pageHeightMm: 297,
    });
    const root = svg as unknown as StubEl;
    const patterns = walk(root, (e) => e.tagName === "pattern");
    expect(patterns.length).toBe(1);
    const images = walk(patterns[0], (e) => e.tagName === "image");
    expect(images.length).toBe(1);
    expect(images[0].getAttribute("href")).toBe("data:image/png;base64,ZZZ");
    // Verzerrte Kachel (scaleX≠scaleY) + Rotation im patternTransform.
    expect(patterns[0].getAttribute("width")).not.toBe(patterns[0].getAttribute("height"));
    expect(patterns[0].getAttribute("patternTransform")).toContain("rotate(30)");
    // Zickzack-Linie als Polylinie mit mehreren Stützpunkten.
    const polylines = walk(root, (e) => e.tagName === "polyline");
    expect(polylines.length).toBeGreaterThan(0);
    expect((polylines[0].getAttribute("points") ?? "").trim().split(/\s+/).length).toBeGreaterThan(3);
  });
});
