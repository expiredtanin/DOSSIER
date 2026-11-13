import { describe, expect, it } from "vitest";
import { IMAGE_MAX_EDGE, PT_EXPORT_MAX_SAMPLES, PT_EXPORT_SAMPLES, clampImageSize, exportSamples, imageFileName, isBlankImage, matteFromBlackWhite, renderPathtraceChunks, type ChunkRenderer } from "./imageExport";

describe("[212] Bild-Export im Pathtracing-Stil", () => {
  it("rechnet N Samples (Vorgabe 64, 1 … 1024)", () => {
    expect(exportSamples(undefined)).toBe(PT_EXPORT_SAMPLES);
    expect(exportSamples(Number.NaN)).toBe(PT_EXPORT_SAMPLES);
    expect(exportSamples(16.4)).toBe(16);
    expect(exportSamples(0)).toBe(1);
    expect(exportSamples(-5)).toBe(1);
    expect(exportSamples(5000)).toBe(PT_EXPORT_MAX_SAMPLES);
  });

  /** Ersatz-Renderer: jedes `render` rechnet `batch` Samples (höchstens bis `cap`), jedes Sample kostet `ms` Zeit. */
  function fake(cap = 1024, ms = 10) {
    const st = { samples: 0, batch: 1, clock: 0, renders: 0 };
    const r: ChunkRenderer = {
      render: () => {
        const n = Math.min(st.batch, cap - st.samples);
        st.samples += n;
        st.clock += n * ms;
        st.renders++;
      },
      pathtrace_samples: () => st.samples,
      set_pathtrace_batch: (n) => {
        st.batch = n;
      },
      gpu_idle: () => Promise.resolve(),
    };
    return { r, st, now: () => st.clock };
  }

  it("Etappe 3: rechnet in Häppchen mit Fortschritt, das letzte bleibt dem Aufrufer", async () => {
    const { r, st, now } = fake();
    const seen: number[] = [];
    const left = await renderPathtraceChunks(r, 256, { onProgress: (d, t) => { expect(t).toBe(256); seen.push(d); } }, now);
    expect(left).not.toBeNull();
    expect(st.samples + (left ?? 0)).toBe(256);
    expect(left).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    // Häppchen wachsen auf ≈ 250 ms (25 Samples à 10 ms).
    expect(Math.max(...seen.slice(1).map((d, i) => d - seen[i]))).toBeGreaterThanOrEqual(20);
  });

  it("Etappe 3: Abbruch und stockende Obergrenze beenden die Schleife", async () => {
    const ctl = new AbortController();
    const { r } = fake();
    const left = await renderPathtraceChunks(r, 1024, { onProgress: (d) => { if (d > 50) ctl.abort(); }, signal: ctl.signal }, () => 0);
    expect(left).toBeNull();
    expect(r.pathtrace_samples()).toBeLessThan(1024);
    // Renderer hält bei 40 an: kein Endlos-Warten.
    const stuck = fake(40);
    const rest = await renderPathtraceChunks(stuck.r, 512, {}, stuck.now);
    expect(stuck.st.samples).toBe(40);
    expect(rest).toBe(512 - 40);
    // Ein Sample: nichts vorab, das Häppchen bleibt dem Aufrufer.
    const one = fake();
    expect(await renderPathtraceChunks(one.r, 1, {}, one.now)).toBe(1);
    expect(one.st.renders).toBe(0);
  });
});

describe("[223] Bild-Export 3D", () => {
  it("Zielgrösse: unverändert, begrenzt mit Seitenverhältnis, Unsinn wird 16 px", () => {
    expect(clampImageSize(3840, 2160)).toEqual({ width: 3840, height: 2160, clamped: false });
    const a1 = clampImageSize(9933, 7016);
    expect(a1.clamped).toBe(true);
    expect(Math.max(a1.width, a1.height)).toBe(IMAGE_MAX_EDGE);
    expect(a1.width / a1.height).toBeCloseTo(9933 / 7016, 2);
    expect(clampImageSize(NaN, -5)).toEqual({ width: 16, height: 16, clamped: false });
  });

  it("transparenter Hintergrund: deckend bleibt, Hintergrund wird 0, halbdeckend wird rekonstruiert", () => {
    // Pixel 0: deckendes Rot, 1: reiner Hintergrund, 2: 50 % Blau (Farbe 0,0,255).
    const black = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 128, 255]);
    const white = new Uint8ClampedArray([255, 0, 0, 255, 255, 255, 255, 255, 128, 128, 255, 255]);
    matteFromBlackWhite(black, white);
    expect([...black.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...black.slice(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(black[11]).toBeGreaterThan(120);
    expect(black[11]).toBeLessThan(135);
    expect(black[10]).toBeGreaterThan(245);
  });

  it("leeres Bild erkennen, Dateiname", () => {
    expect(isBlankImage(new Uint8ClampedArray(64))).toBe(true);
    expect(isBlankImage(new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 0]))).toBe(false);
    expect(imageFileName("Haus Süd", 4000, 3000)).toBe("Haus_S_d-3d-4000x3000.png");
  });
});
