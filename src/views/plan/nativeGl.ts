/**
 * Puffer-Attrappe für den NATIVEN Plan-Renderer (macOS, src-tauri/src/native_embed.rs).
 *
 * Kompilierung (`compilePrimitivesToGpu`) und Chunk-Cache (`GpuChunkCache`) laufen
 * unverändert in TypeScript und sprechen nur diese vier Puffer-Funktionen an
 * (`BufferGl`). Statt eines GL-Kontexts liegen die Bytes danach in Rust: jeder
 * Puffer geht EINMAL als Rohdaten über die Tauri-Schnittstelle (kein JSON); pro
 * Frame wandert danach nur noch der Ausschnitt.
 */

import type { BufferGl, GpuGeometry } from '../../plan/glPlan/glPlanTypes';

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
  line_batches: { start: number; count: number; color: number[]; stroke_mm: number; screen_px: boolean; device_px?: boolean }[];
  origin: [number, number];
  greyed: boolean;
}

/** Blockgrösse für den Änderungsvergleich (Bytes; Vielfaches von 4). */
const BLOCK = 16 * 1024;
/** Mehr als dieser Anteil geänderter Blöcke → lieber komplett senden. */
const PATCH_MAX_FRACTION = 0.35;

/** FNV-1a über 32-Bit-Wörter je Block (Resttail wird mit Nullen aufgefüllt gedacht). */
export function blockHashes(bytes: Uint8Array, block = BLOCK): Uint32Array {
  const n = Math.ceil(bytes.byteLength / block);
  const out = new Uint32Array(n);
  const words = Math.floor(bytes.byteLength / 4);
  const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, words);
  const per = block / 4;
  for (let b = 0; b < n; b++) {
    let h = 0x811c9dc5;
    const end = Math.min(words, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      h ^= u32[i];
      h = Math.imul(h, 0x01000193);
    }
    out[b] = h >>> 0;
  }
  return out;
}

/** Zusammenhängende geänderte Byte-Bereiche (offset, länge) zwischen zwei Hash-Listen. */
export function changedRanges(a: Uint32Array, b: Uint32Array, byteLength: number, block = BLOCK): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < b.length; i++) {
    if (a[i] === b[i]) continue;
    const off = i * block;
    const len = Math.min(block, byteLength - off);
    const last = out[out.length - 1];
    if (last && last[0] + last[1] === off) last[1] += len;
    else out.push([off, len]);
  }
  return out;
}

interface PendingUpload {
  id: number;
  bytes: Uint8Array;
  hashes: Uint32Array;
}

export class NativeGl implements BufferGl {
  readonly ARRAY_BUFFER = 0x8892;
  readonly ELEMENT_ARRAY_BUFFER = 0x8893;
  readonly STATIC_DRAW = 0x88e4;
  readonly packedLineVertices = true;

  private nextId = 1;
  private bound: NativeBuffer | null = null;
  private pendingDelete: number[] = [];
  /** Hashes + Länge ALLER an Rust gesendeten Puffer (für den Änderungsvergleich). */
  private live = new Map<number, { len: number; hashes: Uint32Array }>();
  /** Seit dem letzten `takeLayout` neu befüllte Puffer, noch nicht gesendet. */
  private queue: PendingUpload[] = [];

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
    // KOPIE: die Quelle ist ein wiederverwendeter Wachstumspuffer.
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    this.queue.push({ id: buf.id, bytes, hashes: blockHashes(bytes) });
  }

  deleteBuffer(buffer: WebGLBuffer | null): void {
    if (buffer) this.pendingDelete.push((buffer as unknown as NativeBuffer).id);
  }

  private sendFull(u: PendingUpload): void {
    void this.invoke('native2d_upload', u.bytes, { headers: { 'x-buf-id': String(u.id) } }).catch((e) =>
      console.debug('native2d_upload fehlgeschlagen', e),
    );
  }

  /**
   * Gesammelte Uploads senden. Ersetzt ein neuer Puffer einen gleich grossen,
   * gleichzeitig freigegebenen alten (Chunk-Neuberechnung nach einer kleinen
   * Änderung), gehen NUR die geänderten Blöcke über die Schnittstelle: Rust führt
   * den alten GPU-Puffer unter der neuen ID weiter.
   */
  private flushUploads(deleted: number[]): void {
    const free = new Map<number, number[]>(); // Länge → freigegebene Puffer-IDs
    for (const id of deleted) {
      const e = this.live.get(id);
      if (e) (free.get(e.len) ?? free.set(e.len, []).get(e.len)!).push(id);
    }
    for (const u of this.queue) {
      this.live.set(u.id, { len: u.bytes.byteLength, hashes: u.hashes });
      const cands = free.get(u.bytes.byteLength);
      const oldId = cands?.pop();
      if (oldId === undefined || u.bytes.byteLength < 4 * BLOCK) {
        if (oldId !== undefined) cands!.push(oldId);
        this.sendFull(u);
        continue;
      }
      const old = this.live.get(oldId)!;
      const ranges = changedRanges(old.hashes, u.hashes, u.bytes.byteLength);
      const changedBytes = ranges.reduce((s, r) => s + r[1], 0);
      if (changedBytes > u.bytes.byteLength * PATCH_MAX_FRACTION) {
        cands!.push(oldId);
        this.sendFull(u);
        continue;
      }
      const body = new Uint8Array(changedBytes);
      let pos = 0;
      for (const [off, len] of ranges) {
        body.set(u.bytes.subarray(off, off + len), pos);
        pos += len;
      }
      this.live.delete(oldId); // der alte Puffer lebt unter der neuen ID weiter
      void this.invoke('native2d_patch', body, {
        headers: { 'x-from': String(oldId), 'x-to': String(u.id), 'x-ranges': ranges.map((r) => `${r[0]}:${r[1]}`).join(',') },
      })
        .then((ok) => {
          if (ok !== true) this.sendFull(u); // Rust kannte den alten Puffer nicht → voll senden
        })
        .catch(() => this.sendFull(u));
    }
    this.queue = [];
    for (const id of deleted) this.live.delete(id);
  }

  /** Ausstehende Uploads senden; liefert die freizugebenden Puffer-IDs. */
  takeUploads(): number[] {
    const del = this.pendingDelete;
    this.pendingDelete = [];
    this.flushUploads(del);
    return del;
  }

  /** Geometrien (in Zeichenreihenfolge) → Layout für Rust, plus freizugebende Puffer. */
  takeLayout(geometries: readonly GpuGeometry[]): { layout: NativeChunkLayout[]; delete: number[] } {
    // Erst die Uploads (in Reihenfolge VOR dem Layout-Aufruf des Aufrufers).
    const del = this.takeUploads();
    return { layout: geometries.map((g) => this.layoutOf(g)), delete: del };
  }

  /** Layout-Eintrag einer einzelnen Geometrie. */
  layoutOf(g: GpuGeometry): NativeChunkLayout {
    const id = (b: WebGLBuffer | null): number | null => (b ? (b as unknown as NativeBuffer).id : null);
    return {
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
    };
  }
}
