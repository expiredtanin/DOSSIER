/**
 * Tessellierung: wandelt Plan-`Primitive` in GPU-fertige Puffer — Fassade über den Rust-Kern
 * ([K3b], `src-tauri/core/src/gpu_compile.rs`). Rust tesselliert (Ear-Clipping, Striche mit runden
 * Kappen/Ecken, Schraffur, Zickzack, Motive, Bögen, Kreise) und liefert Vertex-/Index-/Batch-Daten
 * flach zurück; hier werden sie nur noch hochgeladen. Eingabe ist der Plan-Puffer v2
 * (`../planBuf.ts`): Bereiche eines Kern-Puffers (`planDomains`) gehen direkt in die Kompilierung
 * ({@link compilePlanBufRange}, [K3d]), gemischte Listen kodiert TS schlank ({@link compilePrimitivesToGpu}).
 *
 * Koordinaten: alles in BILDSCHIRM-Raum (wie `toScreen`): sx = mx·PX_PER_M, sy = -my·PX_PER_M,
 * relativ zum lokalen Ursprung (`origin`, erster abgelegter Punkt).
 */

import type { Primitive } from '../generatePlan';
import type { Vec2 } from '../../model/types';
import type { BufferGl, GpuGeometry, Rgba } from './glPlanTypes';
import { encodePlanBuf, type DecodedPlanBuf } from '../planBuf';
import { core } from '../../engine/coreWasm';

/**
 * Ear-Clipping-Triangulierung eines einfachen (lochfreien) Polygons, konvex oder konkav.
 * Dreiecks-Indizes (0-basiert auf `pts`); [] bei <3 Ecken oder Degeneration.
 */
export function triangulate(pts: Vec2[]): number[] {
  if (pts.length < 3) return [];
  const flat = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    flat[2 * i] = pts[i].x;
    flat[2 * i + 1] = pts[i].y;
  }
  return Array.from(core().triangulate_flat(flat));
}

/**
 * Tesselliert Plan-Primitive zu GPU-Geometrie (Füllungen + bildschirmkonstante Striche).
 * Text/Bilder bleiben im Overlay.
 */
export function compilePrimitivesToGpu(
  gl: BufferGl,
  primitives: Primitive[],
  // Bildschirm-Massstab (Geräte-px je Modell-Meter) beim aktuellen Zoom. Steuert NUR die
  // adaptive Bogen-Tessellierung; 0 → zoom-unabhängiger Rückfall (16 Segmente je 90°).
  pxPerMeter = 0,
): GpuGeometry {
  const packed = gl.packedLineVertices === true;
  const out = core().gpu_compile_flat(encodePlanBuf(primitives, { lean: true }), 0, primitives.length, pxPerMeter, packed);
  return uploadCompiled(gl, out);
}

/**
 * Wie {@link compilePrimitivesToGpu} für die Primitive `[from, to)` eines Kern-Puffers — ohne
 * Umweg über Objekte: der Puffer wird einmal im Kern abgelegt (`plan_buf_hold`) und für alle
 * Chunks wiederverwendet. Ist er dort verdrängt, wird er neu abgelegt.
 */
export function compilePlanBufRange(gl: BufferGl, src: DecodedPlanBuf, from: number, to: number, pxPerMeter = 0): GpuGeometry {
  const packed = gl.packedLineVertices === true;
  const c = core();
  let out = src.hold ? c.gpu_compile_held(src.hold, from, to, pxPerMeter, packed) : new Uint32Array(0);
  if (out.length === 0) {
    src.hold = c.plan_buf_hold(src.bytes);
    out = src.hold ? c.gpu_compile_held(src.hold, from, to, pxPerMeter, packed) : c.gpu_compile_flat(src.bytes, from, to, pxPerMeter, packed);
  }
  return uploadCompiled(gl, out);
}

/** Flache Kern-Ausgabe (Layout s. `gpu_compile.rs`) → hochgeladene `GpuGeometry`. */
function uploadCompiled(gl: BufferGl, out: Uint32Array): GpuGeometry {
  if (out.length < 2) {
    return {
      fill: { positionBuffer: null, indexBuffer: null, batches: [] },
      line: { vertexBuffer: null, indexBuffer: null, batches: [] },
      origin: { x: 0, y: 0 },
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    };
  }
  const m = out[0];
  const meta = new Float64Array(out.buffer, out.byteOffset + 8, m);
  const [originX, originY, minX, minY, maxX, maxY, nFillPos, nFillIdx, nLineVerts, nLineIdx, nFill, nLine] = meta;
  let k = 12;
  const fillBatches: GpuGeometry['fill']['batches'] = [];
  for (let i = 0; i < nFill; i++, k += 6) {
    fillBatches.push({
      startIndex: meta[k],
      indexCount: meta[k + 1],
      color: [meta[k + 2], meta[k + 3], meta[k + 4], meta[k + 5]] as Rgba,
    });
  }
  const lineBatches: GpuGeometry['line']['batches'] = [];
  for (let i = 0; i < nLine; i++, k += 8) {
    lineBatches.push({
      startIndex: meta[k],
      indexCount: meta[k + 1],
      color: [meta[k + 2], meta[k + 3], meta[k + 4], meta[k + 5]] as Rgba,
      strokeMm: meta[k + 6],
      screenPx: meta[k + 7] === 1,
    });
  }
  let off = out.byteOffset + 8 + m * 8;
  const fillPos = new Float32Array(out.buffer, off, nFillPos);
  off += nFillPos * 4;
  const fillIdx = new Uint32Array(out.buffer, off, nFillIdx);
  off += nFillIdx * 4;
  // Gepackte Linien-Vertices sind Wörter, ungepackte f32 — die Bytes sind dieselben.
  const lineVerts = new Uint32Array(out.buffer, off, nLineVerts);
  off += nLineVerts * 4;
  const lineIdx = new Uint32Array(out.buffer, off, nLineIdx);

  const upload = (target: number, data: ArrayBufferView & { length: number }): WebGLBuffer | null => {
    if (!data.length) return null;
    const buf = gl.createBuffer();
    if (!buf) return null;
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return buf;
  };
  return {
    fill: {
      positionBuffer: upload(gl.ARRAY_BUFFER, fillPos),
      indexBuffer: upload(gl.ELEMENT_ARRAY_BUFFER, fillIdx),
      batches: fillBatches,
    },
    line: {
      vertexBuffer: upload(gl.ARRAY_BUFFER, gl.packedLineVertices === true ? lineVerts : new Float32Array(lineVerts.buffer, lineVerts.byteOffset, lineVerts.length)),
      indexBuffer: upload(gl.ELEMENT_ARRAY_BUFFER, lineIdx),
      batches: lineBatches,
    },
    origin: { x: originX, y: originY },
    bounds: {
      minX: isFinite(minX) ? minX : 0,
      minY: isFinite(minY) ? minY : 0,
      maxX: isFinite(maxX) ? maxX : 1,
      maxY: isFinite(maxY) ? maxY : 1,
    },
  };
}
