import { describe, it, expect } from 'vitest';
import type { Primitive } from '../generatePlan';
import { GpuChunkCache, splitIntoChunks } from './glPlanChunks';

const line = (x: number, drawingId: string): Primitive => ({
  kind: 'line',
  a: { x, y: 0 },
  b: { x: x + 1, y: 0 },
  cls: 'draw2d',
  weightMm: 0.18,
  color: '#000000',
  drawingId,
});
const arc = (drawingId: string): Primitive => ({
  kind: 'drawingArc',
  center: { x: 0, y: 0 },
  r: 5,
  a0: 0,
  a1: Math.PI,
  stroke: '#000000',
  weightMm: 0.18,
  dash: null,
  greyed: false,
  drawingId,
});

function makeGl() {
  const deleted: unknown[] = [];
  const gl = {
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: (b: unknown) => deleted.push(b),
    ARRAY_BUFFER: 1,
    ELEMENT_ARRAY_BUFFER: 2,
    STATIC_DRAW: 3,
  } as unknown as WebGL2RenderingContext;
  return { gl, deleted };
}

/** 2000 Elemente à 3 Segmente; jedes Element mit eigener drawingId. */
const scene = (): Primitive[] => {
  const out: Primitive[] = [];
  for (let d = 0; d < 2000; d++) for (let k = 0; k < 3; k++) out.push(line(d * 10 + k, `d${d}`));
  return out;
};

describe('splitIntoChunks', () => {
  it('deckt alle Primitive lückenlos und ohne Überlapp ab, schneidet nur an Elementgrenzen', () => {
    const prims = scene();
    const chunks = splitIntoChunks(prims);
    expect(chunks.length).toBeGreaterThan(1);
    let expected = 0;
    for (const [s, e] of chunks) {
      expect(s).toBe(expected);
      expected = e;
      if (s > 0) expect((prims[s] as any).drawingId).not.toBe((prims[s - 1] as any).drawingId);
    }
    expect(expected).toBe(prims.length);
  });

  it('bleibt nach Einfügen vorn bei denselben Elementen geschnitten (selbst-synchronisierend)', () => {
    const base = scene();
    const edited = [line(-100, 'neu'), ...base];
    const cut = (ps: Primitive[]) =>
      new Set(splitIntoChunks(ps).slice(1).map(([s]) => (ps[s] as any).drawingId as string));
    const a = cut(base), b = cut(edited);
    let common = 0;
    for (const id of a) if (b.has(id)) common++;
    expect(common / a.size).toBeGreaterThan(0.95);
  });

  it('leere Liste ergibt keine Chunks', () => {
    expect(splitIntoChunks([])).toEqual([]);
  });
});

describe('GpuChunkCache', () => {
  it('kompiliert beim zweiten Lauf mit denselben Primitiven nichts neu', () => {
    const { gl } = makeGl();
    const cache = new GpuChunkCache(gl);
    const prims = scene();
    cache.update(prims, 90, 6);
    expect(cache.lastStats.recompiled).toBe(cache.lastStats.chunks);
    cache.update(prims, 90, 6);
    expect(cache.lastStats.recompiled).toBe(0);
  });

  it('LOD-Wechsel kompiliert nur Chunks mit Bögen neu', () => {
    const { gl } = makeGl();
    const cache = new GpuChunkCache(gl);
    const prims = scene();
    prims.splice(3000, 0, arc('dArc'));
    cache.update(prims, 90, 6);
    const total = cache.lastStats.chunks;
    cache.update(prims, 180, 7);
    expect(cache.lastStats.recompiled).toBe(1);
    expect(total).toBeGreaterThan(2);
  });

  it('eine Änderung kompiliert nur den betroffenen Chunk und gibt dessen GPU-Puffer frei', () => {
    const { gl, deleted } = makeGl();
    const cache = new GpuChunkCache(gl);
    const prims = scene();
    cache.update(prims, 90, 6);
    const edited = prims.slice();
    edited[3001] = line(9999, (prims[3001] as any).drawingId); // neues Objekt
    cache.update(edited, 90, 6);
    expect(cache.lastStats.recompiled).toBe(1);
    expect(deleted.length).toBeGreaterThan(0);
  });

  it('dispose gibt alle Puffer frei', () => {
    const { gl, deleted } = makeGl();
    const cache = new GpuChunkCache(gl);
    cache.update(scene(), 90, 6);
    cache.dispose();
    expect(deleted.length).toBeGreaterThan(0);
    expect(cache.geometries).toEqual([]);
  });
});
