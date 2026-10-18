/**
 * Chunk-Cache für die GPU-Geometrie. Statt den GESAMTEN Plan bei jeder Änderung
 * in EINE Geometrie zu tessellieren (bei einem Kataster-Import mit 3,7 Mio.
 * Linien ~2 s und ein neuer GPU-Puffersatz), wird die Primitiv-Liste in Chunks
 * zerlegt; jeder Chunk hat eine eigene Geometrie und wird nur neu kompiliert,
 * wenn sich sein Inhalt geändert hat.
 *
 * Reihenfolge: der Renderer zeichnet erst alle Füllungen, dann alle Linien (je
 * in Chunk-Reihenfolge) — identisch zur früheren Einzelgeometrie, in der
 * Füllungen ebenfalls vor Linien kamen und innerhalb beider die Primitiv-
 * Reihenfolge galt.
 *
 * Chunk-Grenzen sind INHALTSBASIERT (Hash der `drawingId`), nicht
 * positionsbasiert: wird vorn ein Element eingefügt, verschieben sich alle
 * Indizes dahinter, die Grenzen bleiben aber an denselben Elementen — nur der
 * betroffene Chunk ändert sich.
 *
 * Wiederverwendung: ein Chunk gilt als unverändert, wenn jede seiner
 * Primitive dasselbe OBJEKT ist wie beim letzten Lauf (Referenzvergleich) und,
 * falls er zoomabhängige Primitive (Bögen/Kreise) enthält, der LOD-Bucket
 * gleich ist. Beim blossen Zoomen werden dadurch nur die (wenigen) Chunks mit
 * Bögen neu tesselliert.
 */

import type { Primitive } from '../generatePlan';
import { compilePrimitivesToGpu } from './glPlanCompile';
import type { GpuGeometry } from './glPlanTypes';

/** Ziel: im Mittel so viele Elemente (drawingIds) je Chunk = 2^BITS. */
const BOUNDARY_BITS = 8;
/** Harte Obergrenze je Chunk (Primitive); danach wird an der nächsten Element-Grenze geschnitten. */
const MAX_CHUNK_PRIMS = 200_000;

/** Primitive, deren Tessellierung vom Zoom (pxPerMeter) abhängt. */
const isLodDependent = (p: Primitive): boolean =>
  p.kind === 'arc' || p.kind === 'drawingArc' || p.kind === 'drawingCircle';

function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Index-Bereiche [start, end) der Chunks. */
export function splitIntoChunks(prims: readonly Primitive[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const mask = (1 << BOUNDARY_BITS) - 1;
  let start = 0;
  let prevId: string | undefined = prims.length ? (prims[0] as { drawingId?: string }).drawingId : undefined;
  for (let i = 1; i < prims.length; i++) {
    const id = (prims[i] as { drawingId?: string }).drawingId;
    if (id === prevId) continue;
    // Elementwechsel: hier DARF geschnitten werden.
    if (id !== undefined && ((hashId(id) & mask) === 0 || i - start >= MAX_CHUNK_PRIMS)) {
      out.push([start, i]);
      start = i;
    }
    prevId = id;
  }
  if (prims.length) out.push([start, prims.length]);
  return out;
}

interface Chunk {
  prims: Primitive[];
  dynamic: boolean;
  bucket: number;
  geometry: GpuGeometry;
}

function disposeGeometry(gl: WebGL2RenderingContext, g: GpuGeometry): void {
  gl.deleteBuffer(g.fill.positionBuffer);
  gl.deleteBuffer(g.fill.indexBuffer);
  gl.deleteBuffer(g.line.vertexBuffer);
  gl.deleteBuffer(g.line.indexBuffer);
}

export interface ChunkStats {
  chunks: number;
  recompiled: number;
}

export class GpuChunkCache {
  private chunks: Chunk[] = [];
  /** Statistik des letzten `update`-Laufs (Tests/Diagnose). */
  lastStats: ChunkStats = { chunks: 0, recompiled: 0 };

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /** Geometrien in Zeichenreihenfolge (nur bei `update`/`dispose` neu aufgebaut). */
  geometries: GpuGeometry[] = [];

  update(primitives: readonly Primitive[], pxPerMeter: number, lodBucket: number): void {
    // Alte Chunks nach erstem Primitiv indizieren (Referenz-Identität).
    const old = new Map<Primitive, Chunk>();
    for (const c of this.chunks) if (c.prims.length) old.set(c.prims[0], c);

    const next: Chunk[] = [];
    const reused = new Set<Chunk>();
    let recompiled = 0;
    for (const [start, end] of splitIntoChunks(primitives)) {
      const hit = old.get(primitives[start]);
      if (
        hit &&
        !reused.has(hit) &&
        hit.prims.length === end - start &&
        (!hit.dynamic || hit.bucket === lodBucket) &&
        sameRefs(hit.prims, primitives, start)
      ) {
        reused.add(hit);
        next.push(hit);
        continue;
      }
      const slice = primitives.slice(start, end);
      next.push({
        prims: slice,
        dynamic: slice.some(isLodDependent),
        bucket: lodBucket,
        geometry: compilePrimitivesToGpu(this.gl, slice, pxPerMeter),
      });
      recompiled++;
    }
    for (const c of this.chunks) if (!reused.has(c)) disposeGeometry(this.gl, c.geometry);
    this.chunks = next;
    this.geometries = next.map((c) => c.geometry);
    this.lastStats = { chunks: next.length, recompiled };
  }

  dispose(): void {
    for (const c of this.chunks) disposeGeometry(this.gl, c.geometry);
    this.chunks = [];
    this.geometries = [];
  }
}

function sameRefs(a: readonly Primitive[], b: readonly Primitive[], offset: number): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[offset + i]) return false;
  return true;
}
