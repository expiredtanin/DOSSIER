// [76] Zwei-Punkt-Kalibrierung und Fangindex des PDF-Imports sowie Strichmuster → Linienstil.

import { describe, expect, it } from "vitest";
import {
  buildSnapIndex,
  collectSnapPoints,
  formatScale,
  pdfDistance,
  pdfPaperMm,
  pdfScaleFromDistance,
} from "./pdfCalibrate";
import { PT_TO_MM, type PdfVectorPage, type PdfVectorPath } from "./pdfVector";

const path = (pts: [number, number][], extra: Partial<PdfVectorPath> = {}): PdfVectorPath => ({
  pts: pts.map(([x, y]) => ({ x, y })),
  closed: false,
  stroke: "#000000",
  fill: null,
  evenOdd: false,
  lineWidth: 1,
  dash: [],
  ...extra,
});

const page = (paths: PdfVectorPath[]): PdfVectorPage => ({
  pageCount: 1,
  pageIndex: 0,
  width: 600,
  height: 400,
  mediaBox: [0, 0, 600, 400],
  cropBox: [0, 0, 600, 400],
  rotate: 0,
  truncated: false,
  images: 0,
  paths,
  texts: [],
});

describe("Kalibrierung", () => {
  it("rechnet aus Strecke und wahrer Länge den Massstab", () => {
    // 100 pt = 35.2778 mm Papier; 3.527778 m wahr → 1:100
    const a = { x: 10, y: 10 };
    const b = { x: 110, y: 10 };
    expect(pdfDistance(a, b)).toBe(100);
    expect(pdfPaperMm(a, b)).toBeCloseTo(100 * PT_TO_MM, 9);
    expect(pdfScaleFromDistance(a, b, (100 * PT_TO_MM * 100) / 1000)).toBeCloseTo(100, 9);
    // schiefe Strecke 3-4-5: 500 pt
    const s = pdfScaleFromDistance({ x: 0, y: 0 }, { x: 300, y: 400 }, 17.64);
    expect(s).toBeCloseTo((17.64 * 1000) / (500 * PT_TO_MM), 9);
    expect(formatScale(98.7123)).toBe("98.71");
    expect(formatScale(100)).toBe("100");
  });

  it("verwirft Nulllänge und unsinnige Eingaben", () => {
    const a = { x: 5, y: 5 };
    expect(pdfScaleFromDistance(a, a, 10)).toBeNull();
    expect(pdfScaleFromDistance(a, { x: 6, y: 5 }, 0)).toBeNull();
    expect(pdfScaleFromDistance(a, { x: 6, y: 5 }, -3)).toBeNull();
    expect(pdfScaleFromDistance(a, { x: 6, y: 5 }, Number.NaN)).toBeNull();
    expect(pdfScaleFromDistance(a, { x: Number.NaN, y: 5 }, 3)).toBeNull();
  });
});

describe("Fangindex", () => {
  const circle: PdfVectorPath = path(
    [
      [140, 100],
      [100, 140],
      [60, 100],
      [100, 60],
    ],
    { closed: true, curve: { kind: "circle", cx: 100, cy: 100, r: 40, a0: 0, a1: 2 * Math.PI } },
  );
  const p = page([path([[10, 10], [200, 10]]), path([[200, 10], [200, 300]]), circle]);

  it("sammelt Ecken, Kreismitte und Quadranten", () => {
    const { xs } = collectSnapPoints(p);
    expect(xs.length).toBe(2 + 2 + 4 + 5);
  });

  it("findet den nächsten Punkt im Radius, sonst nichts", () => {
    const idx = buildSnapIndex(p);
    expect(idx.nearest(11, 9, 3)).toEqual({ x: 10, y: 10 });
    expect(idx.nearest(199.5, 299, 3)).toEqual({ x: 200, y: 300 });
    expect(idx.nearest(101, 99, 3)).toEqual({ x: 100, y: 100 }); // Kreismitte
    expect(idx.nearest(300, 200, 3)).toBeNull();
    expect(idx.nearest(11, 9, 0)).toBeNull();
  });

  it("kommt mit leerer Seite und Punkten ausserhalb der Seite zurecht", () => {
    expect(buildSnapIndex(page([])).nearest(1, 1, 5)).toBeNull();
    const out = buildSnapIndex(page([path([[-50, -50], [900, 900]])]));
    expect(out.nearest(-49, -49, 5)).toEqual({ x: -50, y: -50 });
    expect(out.nearest(899, 901, 5)).toEqual({ x: 900, y: 900 });
  });
});
