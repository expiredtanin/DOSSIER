import { describe, expect, it } from 'vitest';
import type { Primitive } from './generatePlan';
import { NativeTextSync, cssColorToRgba, isGpuText, isRotated, isSceneText, svgDrawsTextOverGpu } from './nativeText';

const txt = (id: string, over: Record<string, unknown> = {}) =>
  ({ kind: 'drawingText', drawingId: id, at: { x: 1, y: 2 }, text: 'A', heightM: 2, angle: 0.5, color: '#ff0000', ...over }) as unknown as Primitive;

describe('isGpuText', () => {
  it('einfacher Text ja, Textfeld/Mehrzeiler/ohne Id nein', () => {
    expect(isGpuText(txt('a'))).toBe(true);
    expect(isGpuText(txt('a', { doc: {} }))).toBe(false);
    expect(isGpuText(txt('a', { wrapWidth: 3 }))).toBe(false);
    expect(isGpuText(txt('a', { text: 'x\ny' }))).toBe(false);
    expect(isGpuText(txt('', {}))).toBe(false);
    // [194] Waagrechte Texte zeichnet der Glyphen-Pass, nicht die Vektor-Glyphen.
    expect(isGpuText(txt('a', { angle: 0 }))).toBe(false);
  });
});

describe('isSceneText ([194])', () => {
  it('Raumstempel und waagrechte Textfelder (auch reich/umbrochen), gedrehte nicht', () => {
    expect(isSceneText({ kind: 'text' } as unknown as Primitive)).toBe(true);
    expect(isSceneText(txt('a', { angle: 0 }))).toBe(true);
    expect(isSceneText(txt('a', { angle: 0, doc: {}, wrapWidth: 2 }))).toBe(true);
    expect(isSceneText(txt('a', { angle: null }))).toBe(true); // NaN aus dem Puffer = waagrecht wie im Kern
    expect(isSceneText(txt('a'))).toBe(false);
    expect(isSceneText({ kind: 'line' } as unknown as Primitive)).toBe(false);
    expect(isRotated(1e-12)).toBe(false);
    expect(isRotated(2 * Math.PI)).toBe(false); // Masszahlen tragen oft 2π
    expect(isRotated(-Math.PI / 2)).toBe(true);
  });
});

describe('cssColorToRgba', () => {
  it('versteht #rgb, #rrggbb, rgb()', () => {
    expect(cssColorToRgba('#f00')).toEqual([1, 0, 0, 1]);
    expect(cssColorToRgba('#00ff00', 0.5)).toEqual([0, 1, 0, 0.5]);
    expect(cssColorToRgba('rgb(0, 0, 255)')).toEqual([0, 0, 1, 1]);
    expect(cssColorToRgba('banane')).toEqual([0, 0, 0, 1]);
  });
});

describe('NativeTextSync.delta', () => {
  it('sendet nur Neues/Geändertes und meldet Entferntes', () => {
    const s = new NativeTextSync();
    const a = txt('a'), b = txt('b');
    let d = s.delta([a, b]);
    expect(d.upsert).toHaveLength(2);
    expect(d.upsert[0]).toMatchObject({ x: 90, y: -180, size: 180, angle: -0.5 });
    d = s.delta([a, b]);
    expect(d.upsert).toHaveLength(0);
    expect(d.remove).toHaveLength(0);
    d = s.delta([a, txt('b', { text: 'neu' })]);
    expect(d.upsert.map((u) => u.text)).toEqual(['neu']);
    d = s.delta([a]);
    expect(d.remove).toHaveLength(1);
  });
  it('schliesst den Editor-Text aus', () => {
    const s = new NativeTextSync();
    s.delta([txt('a'), txt('b')]);
    const d = s.delta([txt('a'), txt('b')], 'b');
    expect(d.remove).toHaveLength(1);
  });
});

describe('svgDrawsTextOverGpu [289]: jeder Text genau einmal', () => {
  const stamp = { kind: 'text', at: { x: 0, y: 0 } } as unknown as Primitive;
  const flat = txt('f', { angle: 0 });
  const rotated = txt('r', { angle: 0.5 });
  const line = { kind: 'line' } as unknown as Primitive;

  it('WASM (Browser, Linux/Electron): die Szene zeichnet Stempel und waagrechte Texte, das SVG nur gedrehte', () => {
    const e = { wasm: true, native: false };
    expect(svgDrawsTextOverGpu(stamp, e)).toBe(false);
    expect(svgDrawsTextOverGpu(flat, e)).toBe(false); // vorher true: gedoppelte Schrift
    expect(svgDrawsTextOverGpu(rotated, e)).toBe(true);
    expect(svgDrawsTextOverGpu(line, e)).toBe(false);
  });
  it('native Fläche: Glyphen-Pass und Vektor-Glyphen, sonst SVG', () => {
    expect(svgDrawsTextOverGpu(flat, { wasm: false, native: true, sceneTexts: true, gpuTexts: true })).toBe(false);
    expect(svgDrawsTextOverGpu(rotated, { wasm: false, native: true, sceneTexts: true, gpuTexts: true })).toBe(false);
    expect(svgDrawsTextOverGpu(rotated, { wasm: false, native: true, sceneTexts: true, gpuTexts: false })).toBe(true);
    expect(svgDrawsTextOverGpu(flat, { wasm: false, native: true, sceneTexts: false })).toBe(true);
  });
});
