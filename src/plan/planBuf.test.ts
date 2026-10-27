// Plan-Puffer [K3b]: TS kodiert, Rust liest und schreibt neu — Hin und zurück muss jede Zahl
// erhalten (je Primitiv-Typ), fremde Versionen werden sauber abgelehnt.

import { describe, it, expect } from "vitest";
import { encodePlanBuf, encodeHatch, parseColor, PLAN_BUF_MAGIC, PLAN_BUF_VERSION } from "./planBuf";
import { core } from "../engine/coreWasm";
import type { HatchRender, Primitive } from "./generatePlan";

const hatch: HatchRender = {
  pattern: "custom",
  scale: 2,
  angle: 30,
  color: "#336699",
  lineWeight: 0.13,
  dash: [0.35, 0.3],
  kind: "vector",
  lines: "random",
  origin: { x: 1, y: -2 },
  seed: 7,
  density: 1.5,
  lengthMin: 0.5,
  lengthMax: 2,
  motif: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], length: 2 },
};

const dash = [1, 0.5];

const PRIMS: Record<string, Primitive> = {
  polygon: {
    kind: "polygon",
    pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1.5 }],
    fill: "#ffcc00",
    stroke: "rgba(10, 20, 30, 0.5)",
    strokeWidthMm: 0.35,
    hatch,
    greyed: true,
    opacity: 0.4,
    noStrokeEdges: [0, 2],
    wallId: "w1",
  },
  line: { kind: "line", a: { x: 0, y: 0 }, b: { x: 3, y: 4 }, cls: "c", weightMm: 0.25, color: "#000", dash, drawingId: "d" },
  zigzag: { kind: "line", a: { x: 0, y: 0 }, b: { x: 3, y: 4 }, cls: "c", weightMm: 0.25, zigzag: { amplitude: 1, wavelength: 4 } },
  motif: {
    kind: "line",
    a: { x: 0, y: 0 },
    b: { x: 3, y: 4 },
    cls: "c",
    weightMm: undefined as unknown as number,
    motif: { points: [{ x: 0, y: 0 }, { x: 2, y: 1 }], length: 4 },
  },
  arc: { kind: "arc", center: { x: 0, y: 0 }, from: { x: 1, y: 0 }, to: { x: 0, y: 1 }, r: 1, cls: "c", weightMm: 0.18, opacity: 0.5 },
  drawingCircle: { kind: "drawingCircle", center: { x: 5, y: 5 }, r: 2, fill: "none", stroke: "#123", weightMm: 0.18, dash: [2] },
  drawingArc: { kind: "drawingArc", center: { x: 5, y: 5 }, r: 2, a0: 0, a1: 3, stroke: "#123", weightMm: 0.5, greyed: true },
  text: { kind: "drawingText", at: { x: 0, y: 0 }, text: "x", heightM: 1, angle: 0, color: "#000" },
  image: { kind: "drawingImage", min: { x: 0, y: 0 }, max: { x: 1, y: 1 }, src: "", opacity: 1 },
};

/** Gleichheit Zahl für Zahl (NaN = NaN, −0 ≠ +0). */
function sameBits(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

describe("Plan-Puffer", () => {
  for (const [name, prim] of Object.entries(PRIMS)) {
    it(`Hin und zurück: ${name}`, () => {
      const buf = encodePlanBuf([prim]);
      expect(buf[0]).toBe(PLAN_BUF_MAGIC);
      expect(buf[1]).toBe(PLAN_BUF_VERSION);
      expect(buf[4]).toBe(1);
      expect(sameBits(core().plan_buf_recode(buf), buf)).toBe(true);
    });
  }

  it("Hin und zurück: alle Typen gemischt, ein Eintrag je Primitiv", () => {
    const prims = Object.values(PRIMS);
    const buf = encodePlanBuf(prims);
    expect(buf[4]).toBe(prims.length);
    expect(sameBits(core().plan_buf_recode(buf), buf)).toBe(true);
  });

  it("Texte und Bilder sind Platzhalter (nur der Typ-Eintrag 0)", () => {
    expect(Array.from(encodePlanBuf([PRIMS.text, PRIMS.image]))).toEqual([PLAN_BUF_MAGIC, PLAN_BUF_VERSION, 0, 0, 2, 0, 0]);
  });

  it("Farben werden einmal geparst und geteilt, ungültige ergeben −1", () => {
    const a = { ...PRIMS.line, color: "#ff0000" } as Primitive;
    const b = { ...PRIMS.line, color: "nonsense" } as Primitive;
    const buf = encodePlanBuf([a, a, b]);
    expect(buf[2]).toBe(1);
    expect(Array.from(buf.subarray(5, 9))).toEqual(parseColor("#ff0000"));
  });

  it("Linienzug-Flag: nur gleiches Element, gleicher Stil und lückenlos", () => {
    const seg = (ax: number, bx: number, extra: object = {}): Primitive =>
      ({ kind: "line", a: { x: ax, y: 0 }, b: { x: bx, y: 0 }, cls: "c", weightMm: 0.18, color: "#000", drawingId: "d", ...extra }) as Primitive;
    const flagsOf = (prims: Primitive[]) => {
      const buf = encodePlanBuf(prims);
      const out: number[] = [];
      let i = 5 + buf[2] * 4;
      for (let k = 0; k < prims.length; k++) {
        out.push(buf[i + 1] & 4);
        i += 9 + 1 + buf[i + 9];
      }
      return out;
    };
    expect(flagsOf([seg(0, 1), seg(1, 2), seg(2, 3)])).toEqual([0, 4, 4]);
    expect(flagsOf([seg(0, 1), seg(1.5, 2)])).toEqual([0, 0]);
    expect(flagsOf([seg(0, 1), seg(1, 2, { drawingId: "e" })])).toEqual([0, 0]);
    expect(flagsOf([seg(0, 1), seg(1, 2, { weightMm: 0.5 })])).toEqual([0, 0]);
    expect(flagsOf([seg(0, 1), seg(1, 2, { greyed: false })])).toEqual([0, 0]);
    expect(flagsOf([seg(0, 1, { dash: [1] }), seg(1, 2, { dash: [1] })])).toEqual([0, 0]);
  });

  it("fremde Version oder kaputter Puffer → leeres Ergebnis, kein Absturz", () => {
    const buf = encodePlanBuf(Object.values(PRIMS));
    const wrong = buf.slice();
    wrong[1] = PLAN_BUF_VERSION + 1;
    expect(core().plan_buf_recode(wrong).length).toBe(0);
    expect(core().gpu_compile_flat(wrong, 90, true).length).toBe(0);
    expect(core().plan_buf_recode(buf.subarray(0, buf.length - 3)).length).toBe(0);
    expect(core().gpu_compile_flat(new Float64Array([1, 2, 3]), 90, false).length).toBe(0);
    // Danach arbeitet der Kern normal weiter.
    expect(sameBits(core().plan_buf_recode(buf), buf)).toBe(true);
  });

  it("Einzel-Schraffur hat dasselbe Format wie ein Hatch-Eintrag", () => {
    const h = encodeHatch(hatch);
    const buf = encodePlanBuf([PRIMS.polygon]);
    const colors = buf[2];
    // Im Plan-Puffer steht der Farbindex statt −1.
    const inPlan = buf.slice(5 + colors * 4, 5 + colors * 4 + h.length);
    expect(inPlan[5]).toBeGreaterThanOrEqual(0);
    inPlan[5] = -1;
    expect(sameBits(inPlan, h)).toBe(true);
  });
});
