// Plan-Puffer v2 [K3d]: TS kodiert und liest, Rust liest und schreibt neu — hin und zurück bleibt
// jedes Primitiv gleich (je Typ, gemischt, über den Kern), fremde Versionen werden sauber abgelehnt.

import { describe, it, expect } from "vitest";
import { decodePlanBuf, encodeHatch, encodePlanBuf, PLAN_BUF_MAGIC, PLAN_BUF_VERSION } from "./planBuf";
import { documentFor } from "../core/document";
import { sampleProject } from "../model/sampleProject";
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
  text: { kind: "drawingText", at: { x: 0, y: 0 }, text: "x 𝄞 ü", heightM: 1, angle: 0, color: "#000", drawingId: "t" },
  textPath: { kind: "drawingTextPath", pathPts: [{ x: 0, y: 0 }, { x: 1, y: 2 }], text: "Pfad", heightM: 0.2, color: "#f00", greyed: false },
  image: { kind: "drawingImage", min: { x: 0, y: 0 }, max: { x: 1, y: 1 }, src: "data:image/png;base64,AA", opacity: 1 },
  stamp: {
    kind: "text",
    at: { x: 1, y: 1 },
    doc: { version: 1, paragraphs: [{ align: "center", runs: [{ text: "Bad", marks: { bold: true } }] }] },
    extraLines: [{ text: "4.20 m²", align: "center" }],
    basePt: 10,
    color: "#333",
    roomId: "R1",
  } as unknown as Primitive,
  dashNull: { kind: "arc", center: { x: 0, y: 0 }, from: { x: 1, y: 0 }, to: { x: 0, y: 1 }, r: 1, cls: "c", weightMm: 0.18, dash: null, openingId: "o", stairId: "s", greyed: false },
  manyIds: {
    kind: "polygon",
    pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    fill: "none",
    stroke: "#000",
    strokeWidthMm: 0.1,
    hatch,
    sectionLineId: "sl",
    wallId: "w",
    stairId: "st",
  },
};

/**
 * JSON mit sortierten Schlüsseln. Fehlende Zahlen (TS `undefined`) reisen als NaN — beide fallen
 * hier weg; Kern-Ausgaben vergleichen die Paritätstests mit dem früheren JSON (NaN → null).
 */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    typeof x === "number" && Number.isNaN(x)
      ? undefined
      : x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );
}

/** Flags der Einträge (Kopf und Offsets gelesen wie im Format beschrieben). */
function recFlags(bytes: Uint8Array): number[] {
  const f = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 3);
  const [nStrings, , nHatchWords, nGroups, nPrims] = [f[3], f[4], f[5], f[6], f[7]];
  const offAt = 16 + 2 * nStrings + nHatchWords + 2 * nGroups;
  const recAt = offAt + nPrims * (f[2] & 1 ? 2 : 1);
  return Array.from({ length: nPrims }, (_, i) => f[recAt + f[offAt + i] + 1]);
}

describe("Plan-Puffer v2", () => {
  for (const [name, prim] of Object.entries(PRIMS)) {
    it(`Hin und zurück: ${name}`, () => {
      const buf = encodePlanBuf([prim]);
      const head = new Float64Array(buf.buffer, 0, 8);
      expect(head[0]).toBe(PLAN_BUF_MAGIC);
      expect(head[1]).toBe(PLAN_BUF_VERSION);
      expect(head[7]).toBe(1);
      expect(canon(decodePlanBuf(buf).prims)).toBe(canon([prim]));
      // Über den Kern (lesen + neu schreiben) bleibt der Inhalt gleich.
      expect(canon(decodePlanBuf(core().plan_buf_recode(buf)).prims)).toBe(canon([prim]));
    });
  }

  it("Hin und zurück: alle Typen gemischt, mit Gruppen und Ausmass", () => {
    const prims = Object.values(PRIMS);
    const buf = encodePlanBuf(prims, { groups: [[0, 2], [2, prims.length]], bounds: [-1, -2, 3, 4] });
    const d = decodePlanBuf(buf);
    expect(canon(d.prims)).toBe(canon(prims));
    expect(d.groups).toEqual([[0, 2], [2, prims.length]]);
    expect(d.bounds).toEqual([-1, -2, 3, 4]);
    expect(d.hashes).toBeNull();
    const back = decodePlanBuf(core().plan_buf_recode(buf));
    expect(canon(back.prims)).toBe(canon(prims));
    expect(back.groups).toEqual(d.groups);
    // Schraffuren werden einmal gelesen und geteilt.
    expect((d.prims[0] as { hatch: unknown }).hatch).toBe((d.prims[prims.length - 1] as { hatch: unknown }).hatch);
  });

  it("Texte mit einzelnen Surrogaten bleiben in TS exakt", () => {
    const t = { ...PRIMS.text, text: "a\ud800b\udfff" } as Primitive;
    expect(decodePlanBuf(encodePlanBuf([t])).prims[0]).toEqual(t);
  });

  it("schlank (nur GPU): Texte/Bilder als Platzhalter, ohne Ids und Klassen", () => {
    const prims = Object.values(PRIMS);
    const lean = encodePlanBuf(prims, { lean: true });
    expect(lean.byteLength).toBeLessThan(encodePlanBuf(prims).byteLength);
    expect(() => decodePlanBuf(lean)).toThrow();
    // Die GPU-Kompilierung liest beide gleich.
    const a = core().gpu_compile_flat(lean, 0, prims.length, 90, true);
    const b = core().gpu_compile_flat(encodePlanBuf(prims), 0, prims.length, 90, true);
    expect(a.length).toBeGreaterThan(30);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("Linienzug-Flag: nur gleiches Element, gleicher Stil und lückenlos", () => {
    const seg = (ax: number, bx: number, extra: object = {}): Primitive =>
      ({ kind: "line", a: { x: ax, y: 0 }, b: { x: bx, y: 0 }, cls: "c", weightMm: 0.18, color: "#000", drawingId: "d", ...extra }) as Primitive;
    const chain = (prims: Primitive[]) => recFlags(encodePlanBuf(prims)).map((fl) => fl & 8);
    expect(chain([seg(0, 1), seg(1, 2), seg(2, 3)])).toEqual([0, 8, 8]);
    expect(chain([seg(0, 1), seg(1.5, 2)])).toEqual([0, 0]);
    expect(chain([seg(0, 1), seg(1, 2, { drawingId: "e" })])).toEqual([0, 0]);
    expect(chain([seg(0, 1), seg(1, 2, { weightMm: 0.5 })])).toEqual([0, 0]);
    expect(chain([seg(0, 1), seg(1, 2, { greyed: false })])).toEqual([0, 0]);
    // Strichmuster: dieselbe Referenz verbindet, gleiche Werte in neuen Listen nicht.
    expect(chain([seg(0, 1, { dash: [1] }), seg(1, 2, { dash: [1] })])).toEqual([0, 0]);
    const d = [1];
    expect(chain([seg(0, 1, { dash: d }), seg(1, 2, { dash: d })])).toEqual([0, 8]);
    expect(chain([seg(0, 1, { dash: null }), seg(1, 2, { dash: null })])).toEqual([0, 8]);
  });

  it("fremde Version oder kaputter Puffer → leeres Ergebnis bzw. Fehler, kein Absturz", () => {
    const prims = Object.values(PRIMS);
    const buf = encodePlanBuf(prims);
    const wrong = buf.slice();
    new Float64Array(wrong.buffer, 0, 2)[1] = PLAN_BUF_VERSION + 1;
    expect(core().plan_buf_recode(wrong).length).toBe(0);
    expect(core().gpu_compile_flat(wrong, 0, 1, 90, true).length).toBe(0);
    expect(() => decodePlanBuf(wrong)).toThrow(/Version/);
    expect(core().plan_buf_recode(buf.subarray(0, buf.length - 3)).length).toBe(0);
    expect(() => decodePlanBuf(buf.subarray(0, buf.length - 2))).toThrow();
    expect(core().gpu_compile_flat(new Uint8Array([1, 2, 3]), 0, 0, 90, false).length).toBe(0);
    expect(core().gpu_compile_flat(buf, 0, prims.length + 1, 90, false).length).toBe(0);
    expect(core().gpu_compile_held(424242, 0, 1, 90, false).length).toBe(0);
    expect(core().plan_buf_hold(wrong)).toBe(0);
    // Danach arbeitet der Kern normal weiter.
    expect(canon(decodePlanBuf(core().plan_buf_recode(buf)).prims)).toBe(canon(prims));
  });

  it("gehaltener Puffer kompiliert wie der übergebene", () => {
    const prims = Object.values(PRIMS);
    const buf = encodePlanBuf(prims);
    const id = core().plan_buf_hold(buf);
    expect(id).toBeGreaterThan(0);
    expect(Array.from(core().gpu_compile_held(id, 1, 5, 90, true))).toEqual(Array.from(core().gpu_compile_flat(buf, 1, 5, 90, true)));
    core().plan_buf_release(id);
    expect(core().gpu_compile_held(id, 1, 5, 90, true).length).toBe(0);
  });

  it("Fehler einer Kern-Abfrage kommen als Meldung", () => {
    const doc = documentFor(sampleProject);
    expect(() => decodePlanBuf(doc.queryBin("planDomains", [1], "kein json"))).toThrow(/Plan-Argumente/);
  });

  it("Einzel-Schraffur hat dasselbe Format wie ein Hatch-Eintrag", () => {
    const h = encodeHatch(hatch);
    const buf = encodePlanBuf([PRIMS.polygon]);
    const f = new Float64Array(buf.buffer, 0, buf.byteLength >> 3);
    const at = 16 + 2 * f[3] + 1; // nach dem JSON-String-Index des ersten Eintrags
    const inPlan = f.slice(at, at + h.length);
    // Im Plan-Puffer steht der Farb-String statt −1.
    expect(inPlan[5]).toBeGreaterThanOrEqual(0);
    inPlan[5] = -1;
    expect(Array.from(inPlan)).toEqual(Array.from(h));
  });
});
