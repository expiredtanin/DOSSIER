import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { encodeRenderScene, SCENE_BIN_VERSION } from "./renderSceneBin";
import type { RScene } from "./toRenderScene";

const FIXTURE = new URL("../../src-tauri/render2d/tests/fixtures/scene_v1.bin", import.meta.url);

/** Beispielszene; MUSS mit `sample()` in `src-tauri/render2d/src/scene_bin.rs` übereinstimmen. */
function sampleScene(): RScene {
  return {
    fills: [
      { pts: [[0, 0], [4, 0], [4, 3]], color: [0.5, 0.25, 0.75, 1], z: 0 },
      { pts: [[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]], color: [1, 1, 1, 0.5], z: 7 },
    ],
    outlines: [{ pts: [[0, 0], [4, 0], [4, 3]], color: [0, 0, 0, 1], widthMm: 0.25, dash: [2, 1], z: 1 }],
    polylines: [
      { pts: [[0, 0], [1, 1]], color: [0.25, 0.25, 0.25, 1], widthMm: 0.5, dash: null, z: 2 },
      { pts: [[5, 5], [6, 5], [6, 6]], color: [0.5, 0.5, 0.5, 1], widthMm: 1, dash: [1], z: 3, widthScreen: true },
    ],
    arcs: [{ center: [1, 1], from: [2, 1], to: [1, 2], r: 1, color: [1, 0, 0, 1], widthMm: 0.125 }],
    lines: [{ a: [0, 0], b: [2600000.5, 1200000.25], color: [0, 0.5, 0, 1], widthMm: 0.35, dash: [3, 1, 0.5, 1], z: 4 }],
    texts: [
      { pos: [1, 2], content: "Küche 12,5 m²", sizeMm: 2.5, color: [0, 0, 0, 1], align: "center" },
      { pos: [3, 4], content: "", sizeMm: 2, color: [0, 0, 0, 1], align: "right" },
      { pos: [5, 6], content: "A", sizeMm: 1, color: [0, 0, 1, 1], align: "left" },
    ],
    images: [],
    bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  };
}

const empty = (): RScene => ({
  fills: [], outlines: [], polylines: [], arcs: [], lines: [], texts: [], images: [],
  bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
});

describe("encodeRenderScene", () => {
  it("liefert byte-genau die Fixture, die der Rust-Dekodierer liest", () => {
    const bytes = encodeRenderScene(sampleScene());
    if (process.env.UPDATE_SCENE_FIXTURE) writeFileSync(FIXTURE, bytes);
    expect(Buffer.from(bytes).equals(readFileSync(FIXTURE))).toBe(true);
  });

  it("schreibt Kopf, Zähler und die exakte Länge", () => {
    const bytes = encodeRenderScene(sampleScene());
    const h = new Uint32Array(bytes.buffer, bytes.byteOffset, 12);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("DR2S");
    expect(h[1]).toBe(SCENE_BIN_VERSION);
    expect([...h.subarray(2, 8)]).toEqual([2, 1, 2, 1, 1, 3]);
    const nPts = 3 + 4 + 3 + 2 + 3 + 3 + 2 + 3;
    expect(h[8]).toBe(nPts);
    expect(h[9]).toBe(2 + 1 + 4);
    expect(h[10]).toBe(new TextEncoder().encode("Küche 12,5 m²A").length);
    const words = 2 * 6 + 8 + 2 * 9 + 7 + 7 + 3 * 8;
    expect(bytes.length).toBe(48 + nPts * 16 + 7 * 4 + words * 4 + h[10]);
  });

  it("behält Koordinaten als f64 (LV95-gross)", () => {
    const s = empty();
    s.lines.push({ a: [2600000.123456, 1200000.654321], b: [0, 0], color: [0, 0, 0, 1], widthMm: 0.1, z: 0 });
    const bytes = encodeRenderScene(s);
    const pts = new Float64Array(bytes.buffer, bytes.byteOffset + 48, 4);
    expect(pts[0]).toBe(2600000.123456);
    expect(pts[1]).toBe(1200000.654321);
  });

  it("kodiert die leere Szene als reinen Kopf und wirft bei Unsinn nicht", () => {
    expect(encodeRenderScene(empty()).length).toBe(48);
    const s = empty();
    s.fills.push({ pts: [], color: [NaN, 0, 0, 1], z: -1 });
    s.texts.push({ pos: [Infinity, 0], content: "\u{1F600}", sizeMm: 1, color: [0, 0, 0, 1], align: "left" });
    expect(() => encodeRenderScene(s)).not.toThrow();
  });
});

/** Zufallsszene (deterministisch) für die Messung. */
function bigScene(nLines: number, nFills: number, nTexts: number): RScene {
  let seed = 42;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) / 16777216;
  const s = empty();
  for (let i = 0; i < nLines; i++) {
    const x = rnd() * 500, y = rnd() * 500;
    s.lines.push({ a: [x, y], b: [x + rnd(), y + rnd()], color: [0.1, 0.1, 0.1, 1], widthMm: 0.18, dash: i % 10 === 0 ? [2, 1] : null, z: i % 50 });
  }
  for (let i = 0; i < nFills; i++) {
    const x = rnd() * 500, y = rnd() * 500;
    s.fills.push({ pts: [0, 1, 2, 3, 4, 5].map((k) => [x + k * rnd(), y + k * rnd()] as [number, number]), color: [0.8, 0.8, 0.75, 1], z: i % 50 });
  }
  for (let i = 0; i < nTexts; i++) {
    s.texts.push({ pos: [rnd() * 500, rnd() * 500], content: `Raum ${i} 12,5 m²`, sizeMm: 2, color: [0, 0, 0, 1], align: "center" });
  }
  return s;
}

describe("Messung JSON gegen Binär (Kodierung, Node)", () => {
  it("kodiert kleine und grosse Szene und gibt die Zeiten aus", () => {
    const best = (f: () => unknown) => {
      let b = Infinity;
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        f();
        b = Math.min(b, performance.now() - t);
      }
      return b;
    };
    for (const [name, sc] of [
      ["klein (200 Linien, 50 Füllungen, 20 Texte)", bigScene(200, 50, 20)],
      ["gross (200000 Linien, 20000 Füllungen, 1000 Texte)", bigScene(200_000, 20_000, 1000)],
    ] as const) {
      const json = JSON.stringify(sc);
      const bin = encodeRenderScene(sc);
      const tj = best(() => JSON.stringify(sc));
      const tb = best(() => encodeRenderScene(sc));
      console.log(`${name}: JSON ${(json.length / 1024) | 0} KB ${tj.toFixed(2)} ms | binär ${(bin.length / 1024) | 0} KB ${tb.toFixed(2)} ms`);
      expect(bin.length).toBeLessThan(json.length);
    }
  });
});
