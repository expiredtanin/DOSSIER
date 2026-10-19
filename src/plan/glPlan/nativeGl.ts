/**
 * Puffer-Attrappe für den NATIVEN Plan-Renderer (macOS, src-tauri/src/native_embed.rs).
 *
 * Kompilierung (`compilePrimitivesToGpu`) und Chunk-Cache (`GpuChunkCache`) laufen
 * unverändert in TypeScript und sprechen nur diese vier Puffer-Funktionen an
 * (`BufferGl`). Statt eines GL-Kontexts liegen die Bytes danach in Rust: jeder
 * Puffer geht EINMAL als Rohdaten über die Tauri-Schnittstelle (kein JSON); pro
 * Frame wandert danach nur noch der Ausschnitt.
 */

import type { BufferGl, GpuGeometry } from './glPlanTypes';

export type NativeInvoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;

interface NativeBuffer {
  id: number;
}

/** Layout-Eintrag einer Geometrie (Spiegel von `ChunkGeom` in render2d/chunks.rs). */
export interface NativeChunkLayout {
  fill_pos: number | null;
  fill_idx: number | null;
  fill_batches: { start: number; count: number; color: number[] }[];
  line_vtx: number | null;
  line_idx: number | null;
  line_batches: { start: number; count: number; color: number[]; stroke_mm: number; screen_px: boolean }[];
  origin: [number, number];
  greyed: boolean;
}

export class NativeGl implements BufferGl {
  readonly ARRAY_BUFFER = 0x8892;
  readonly ELEMENT_ARRAY_BUFFER = 0x8893;
  readonly STATIC_DRAW = 0x88e4;
  readonly packedLineVertices = true;

  private nextId = 1;
  private bound: NativeBuffer | null = null;
  private pendingDelete: number[] = [];

  constructor(private readonly invoke: NativeInvoke) {}

  createBuffer(): WebGLBuffer {
    return { id: this.nextId++ } as unknown as WebGLBuffer;
  }

  bindBuffer(_target: number, buffer: WebGLBuffer | null): void {
    this.bound = buffer as unknown as NativeBuffer | null;
  }

  bufferData(_target: number, data: ArrayBufferView, _usage: number): void {
    const buf = this.bound;
    if (!buf) return;
    // KOPIE: die Quelle ist ein wiederverwendeter Wachstumspuffer, der Aufruf
    // serialisiert asynchron.
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    void this.invoke('native2d_upload', bytes, { headers: { 'x-buf-id': String(buf.id) } }).catch((e) =>
      console.debug('native2d_upload fehlgeschlagen', e),
    );
  }

  deleteBuffer(buffer: WebGLBuffer | null): void {
    if (buffer) this.pendingDelete.push((buffer as unknown as NativeBuffer).id);
  }

  /** Geometrien (in Zeichenreihenfolge) → Layout für Rust, plus freizugebende Puffer. */
  takeLayout(geometries: readonly GpuGeometry[]): { layout: NativeChunkLayout[]; delete: number[] } {
    const id = (b: WebGLBuffer | null): number | null => (b ? (b as unknown as NativeBuffer).id : null);
    const layout = geometries.map((g) => ({
      fill_pos: id(g.fill.positionBuffer),
      fill_idx: id(g.fill.indexBuffer),
      fill_batches: g.fill.batches.map((b) => ({ start: b.startIndex, count: b.indexCount, color: b.color })),
      line_vtx: id(g.line.vertexBuffer),
      line_idx: id(g.line.indexBuffer),
      line_batches: g.line.batches.map((b) => ({
        start: b.startIndex,
        count: b.indexCount,
        color: b.color,
        stroke_mm: b.strokeMm,
        screen_px: !!b.screenPx,
      })),
      origin: [g.origin?.x ?? 0, g.origin?.y ?? 0] as [number, number],
      greyed: !!g.greyed,
    }));
    const del = this.pendingDelete;
    this.pendingDelete = [];
    return { layout, delete: del };
  }
}
