import { describe, it, expect } from 'vitest';
import type { Primitive, UnderlayGroup } from '../generatePlan';
import { generatePlan } from '../generatePlan';
import type { Drawing2D, Project } from '../../model/types';
import { flattenCategories } from '../../model/types';
import { bigSampleProject } from '../bigSampleProject.testing';
import { GpuChunkCache, splitIntoChunks } from './glPlanChunks';
import { compilePlanBufRange, compilePrimitivesToGpu } from './glPlanCompile';

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

  it('eine Änderung kompiliert nur den betroffenen Chunk; der alte bleibt nur bis zum nächsten Lauf erhalten', () => {
    const { gl, deleted } = makeGl();
    const cache = new GpuChunkCache(gl);
    const prims = scene();
    cache.update(prims, 90, 6);
    const edited = prims.slice();
    edited[3001] = line(9999, (prims[3001] as any).drawingId); // neues Objekt
    cache.update(edited, 90, 6);
    expect(cache.lastStats.recompiled).toBe(1);
    expect(deleted.length).toBe(0); // alter Chunk noch als "andere Variante" behalten
    cache.update(edited, 90, 6);
    expect(cache.lastStats.recompiled).toBe(0);
    expect(deleted.length).toBeGreaterThan(0); // nicht mehr gebrauchte Variante jetzt freigegeben
  });

  it('Hin- und Herwechseln zwischen zwei Varianten kompiliert nichts neu', () => {
    const { gl } = makeGl();
    const cache = new GpuChunkCache(gl);
    const a = scene();
    const b = a.map((p) => ({ ...p, greyed: true }) as Primitive); // z. B. Ebene als Referenz gedimmt
    cache.update(a, 90, 6);
    cache.update(b, 90, 6);
    expect(cache.lastStats.recompiled).toBe(cache.lastStats.chunks);
    cache.update(a, 90, 6);
    expect(cache.lastStats.recompiled).toBe(0);
    cache.update(b, 90, 6);
    expect(cache.lastStats.recompiled).toBe(0);
  });

  it('gedimmte Bereiche: dieselbe Geometrie wird nur anders markiert, nichts wird neu kompiliert', () => {
    const { gl } = makeGl();
    const cache = new GpuChunkCache(gl);
    const prims = scene();
    cache.update(prims, 90, 6);
    expect(cache.geometries.some((g) => g.greyed)).toBe(false);
    const half = Math.floor(prims.length / 2);
    cache.update(prims, 90, 6, [[half, prims.length]]);
    // Beide Seiten der Bereichsgrenze sind eigene Chunks → höchstens diese zwei neu.
    expect(cache.lastStats.recompiled).toBeLessThanOrEqual(2);
    expect(cache.geometries.some((g) => g.greyed)).toBe(true);
    expect(cache.geometries.some((g) => !g.greyed)).toBe(true);
    const flags = cache.geometries.map((g) => !!g.greyed);
    // Gedimmt ist genau ein zusammenhängender Block am Ende.
    expect(flags.indexOf(true)).toBeGreaterThan(0);
    expect(flags.slice(flags.indexOf(true)).every(Boolean)).toBe(true);
    // Zurück auf "nicht gedimmt": keine Neukompilierung.
    cache.update(prims, 90, 6);
    expect(cache.lastStats.recompiled).toBeLessThanOrEqual(2);
    expect(cache.geometries.some((g) => g.greyed)).toBe(false);
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

describe('GpuChunkCache: kompakte Unterlage', () => {
  const drawing = (id: string, x: number) =>
    ({ id, type: 'drawing2d', levelId: 'L', categoryCode: '60', geom: { shape: 'line', a: { x, y: 0 }, b: { x: x + 1, y: 0 } } }) as unknown as Drawing2D;
  const many = (n: number): Drawing2D[] => Array.from({ length: n }, (_, i) => drawing(`u${i}`, i));
  const group = (drawings: Drawing2D[], over: Partial<UnderlayGroup> = {}): UnderlayGroup => ({
    drawings,
    catGreyed: false,
    tint: false,
    above: true,
    ctx: [1],
    build: (ds) => ds.map((d) => line((d.geom as any).a.x, d.id)),
    ...over,
  });

  it('kompiliert beim zweiten Lauf nichts neu; eine geänderte Zeichnung nur ihren Chunk', () => {
    const { gl, deleted } = makeGl();
    const cache = new GpuChunkCache(gl);
    const ds = many(2000);
    cache.update([], 90, 6, undefined, [group(ds)]);
    const total = cache.lastStats.chunks;
    expect(total).toBeGreaterThan(2);
    cache.update([], 90, 6, undefined, [group(ds)]);
    expect(cache.lastStats.recompiled).toBe(0);
    const edited = ds.slice();
    edited[1000] = drawing('u1000', 5000);
    cache.update([], 90, 6, undefined, [group(edited)]);
    expect(cache.lastStats.recompiled).toBe(1);
    cache.update([], 90, 6, undefined, [group(edited)]);
    expect(deleted.length).toBeGreaterThan(0);
  });

  it('geänderter Kontext (ctx) erzwingt Neukompilierung aller Chunks', () => {
    const { gl } = makeGl();
    const cache = new GpuChunkCache(gl);
    const ds = many(2000);
    cache.update([], 90, 6, undefined, [group(ds, { ctx: [1] })]);
    const total = cache.lastStats.chunks;
    cache.update([], 90, 6, undefined, [group(ds, { ctx: [2] })]);
    expect(cache.lastStats.recompiled).toBe(total);
  });

  it('Reihenfolge: Referenz-Ebenen unten, Primitive, aktive Ebene oben; Tönung nur bei tint', () => {
    const { gl } = makeGl();
    const cache = new GpuChunkCache(gl);
    const below = group(many(3), { above: false, tint: true });
    const above = group([0, 1, 2].map((i) => drawing(`a${i}`, i)), { above: true });
    cache.update(scene().slice(0, 6), 90, 6, undefined, [above, below]);
    const g = cache.geometries;
    expect(g[0].greyed).toBe(true); // unten, getönt
    expect(g[g.length - 1].greyed).toBeFalsy(); // oben, normal
    expect(g.length).toBe(3); // 1 unten + 1 Primitiv-Chunk + 1 oben
  });
});

describe('GpuChunkCache: Kern-Abschnitte (Plan-Puffer v2, Inhalts-Hash)', () => {
  const codes = (p: Project) => new Set(flattenCategories(p.layers).map((c) => c.code));
  /** GL, das die hochgeladenen Daten mitschreibt. */
  function recordingGl() {
    const uploads: number[][] = [];
    const gl = {
      createBuffer: () => ({}),
      bindBuffer: () => {},
      bufferData: (_t: number, d: ArrayBufferView) => uploads.push(Array.from(new Uint8Array(d.buffer, d.byteOffset, d.byteLength))),
      deleteBuffer: () => {},
      ARRAY_BUFFER: 1,
      ELEMENT_ARRAY_BUFFER: 2,
      STATIC_DRAW: 3,
    } as unknown as WebGL2RenderingContext;
    return { gl, uploads };
  }

  it('neu erzeugter Plan (neue Objekte, gleicher Inhalt) kompiliert nichts neu', () => {
    const p = bigSampleProject(4);
    const { gl } = makeGl();
    const cache = new GpuChunkCache(gl);
    const a = generatePlan(p, 'eg', codes(p));
    expect(a.bufRuns?.length).toBe(1);
    cache.update(a.primitives, 90, 6, a.greyedRanges, a.underlay, a.bufRuns);
    expect(cache.lastStats.recompiled).toBe(cache.lastStats.chunks);
    const b = generatePlan(p, 'eg', codes(p));
    expect(b.primitives[0]).not.toBe(a.primitives[0]);
    cache.update(b.primitives, 90, 6, b.greyedRanges, b.underlay, b.bufRuns);
    expect(cache.lastStats.recompiled).toBe(0);
    // Ohne Abschnitte (Objekt-Identität) wäre alles neu.
    const c = generatePlan(p, 'eg', codes(p));
    cache.update(c.primitives, 90, 6, c.greyedRanges, c.underlay);
    expect(cache.lastStats.recompiled).toBe(cache.lastStats.chunks);
  });

  it('eine verschobene Wand kompiliert nur wenige Chunks neu', () => {
    const p = bigSampleProject(8);
    const { gl } = makeGl();
    const cache = new GpuChunkCache(gl);
    const a = generatePlan(p, 'eg', codes(p));
    cache.update(a.primitives, 90, 6, a.greyedRanges, a.underlay, a.bufRuns);
    const total = cache.lastStats.chunks;
    expect(total).toBeGreaterThan(8);
    const walls = p.walls.slice();
    walls[200] = { ...walls[200], end: { x: walls[200].end.x + 0.05, y: walls[200].end.y } };
    const b = generatePlan({ ...p, walls }, 'eg', codes(p));
    cache.update(b.primitives, 90, 6, b.greyedRanges, b.underlay, b.bufRuns);
    expect(cache.lastStats.recompiled).toBeGreaterThan(0);
    expect(cache.lastStats.recompiled).toBeLessThanOrEqual(3);
  });

  it('ersetzte Primitive (gedimmt geklont) fallen auf den Objekt-Weg zurück', () => {
    const p = bigSampleProject(2);
    const { gl } = makeGl();
    const cache = new GpuChunkCache(gl);
    const a = generatePlan(p, 'eg', codes(p));
    const prims = a.primitives.slice();
    prims[10] = { ...prims[10], greyed: true } as Primitive;
    cache.update(prims, 90, 6, a.greyedRanges, a.underlay, a.bufRuns);
    const n = cache.lastStats.chunks;
    cache.update(prims, 90, 6, a.greyedRanges, a.underlay, a.bufRuns);
    expect(cache.lastStats.recompiled).toBe(0);
    expect(cache.lastStats.chunks).toBe(n);
  });

  it('direkt aus dem Puffer = über die Objekte (gleiche hochgeladene Daten)', { timeout: 60_000 }, () => {
    const p = bigSampleProject(2);
    const plan = generatePlan(p, 'eg', codes(p));
    const run = plan.bufRuns![0];
    for (const [from, to] of [[run.from, run.to], [run.from + 3, run.to - 5]]) {
      const x = recordingGl();
      const y = recordingGl();
      compilePlanBufRange(x.gl, run.buf, from, to, 120);
      compilePrimitivesToGpu(y.gl, run.buf.prims.slice(from, to), 120);
      expect(x.uploads.length).toBeGreaterThan(2);
      expect(x.uploads).toEqual(y.uploads);
    }
  });
});
