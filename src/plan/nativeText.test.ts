import { describe, expect, it } from 'vitest';
import type { Primitive } from './generatePlan';
import { NativeTextSync, cssColorToRgba, isGpuText } from './nativeText';

const txt = (id: string, over: Record<string, unknown> = {}) =>
  ({ kind: 'drawingText', drawingId: id, at: { x: 1, y: 2 }, text: 'A', heightM: 2, angle: 0.5, color: '#ff0000', ...over }) as unknown as Primitive;

describe('isGpuText', () => {
  it('einfacher Text ja, Textfeld/Mehrzeiler/ohne Id nein', () => {
    expect(isGpuText(txt('a'))).toBe(true);
    expect(isGpuText(txt('a', { doc: {} }))).toBe(false);
    expect(isGpuText(txt('a', { wrapWidth: 3 }))).toBe(false);
    expect(isGpuText(txt('a', { text: 'x\ny' }))).toBe(false);
    expect(isGpuText(txt('', {}))).toBe(false);
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
