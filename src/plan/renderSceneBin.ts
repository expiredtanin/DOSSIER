// Binärkodierung der Render-Szene (`RScene`) für render2d — Gegenstück zu
// `src-tauri/render2d/src/scene_bin.rs` (dort steht die Formatbeschreibung; beide Seiten
// müssen Version und Aufbau gleich halten, die gemeinsame Fixture
// `src-tauri/render2d/tests/fixtures/scene_v1.bin` prüft das in beiden Tests).
//
// Zweiphasig: erst Zähler (Punkte, Strichmuster, Strings), dann ein einziger Puffer, in den
// über typisierte Sichten geschrieben wird (kein DataView je Wert, keine Zwischenarrays).
// Little-endian setzen wir voraus (alle Zielplattformen); `LITTLE_ENDIAN` prüft das einmal.

import type { RScene, RTextAlign } from "./toRenderScene";

export const SCENE_BIN_VERSION = 1;
const HEADER_BYTES = 48;
const ALIGN: Record<RTextAlign, number> = { left: 0, center: 1, right: 2 };

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

const textEncoder = new TextEncoder();

/** Kodiert die Szene (ohne `images`/`bounds`, die der Renderer nicht kennt). */
export function encodeRenderScene(scene: RScene): Uint8Array {
  if (!LITTLE_ENDIAN) throw new Error("Szenenkodierung setzt Little-Endian voraus");
  const { fills, outlines, polylines, arcs, lines, texts } = scene;

  let nPts = 0;
  let nDash = 0;
  for (const f of fills) nPts += f.pts.length;
  for (const o of outlines) {
    nPts += o.pts.length;
    nDash += o.dash?.length ?? 0;
  }
  for (const p of polylines) {
    nPts += p.pts.length;
    nDash += p.dash?.length ?? 0;
  }
  for (const a of arcs) nDash += a.dash?.length ?? 0;
  for (const l of lines) nDash += l.dash?.length ?? 0;
  nPts += arcs.length * 3 + lines.length * 2 + texts.length;

  const strs: Uint8Array[] = new Array(texts.length);
  let strBytes = 0;
  for (let i = 0; i < texts.length; i++) {
    strs[i] = textEncoder.encode(texts[i].content);
    strBytes += strs[i].length;
  }

  const words =
    fills.length * 6 + outlines.length * 8 + polylines.length * 9 + arcs.length * 7 + lines.length * 7 + texts.length * 8;
  const ptsOff = HEADER_BYTES;
  const dashOff = ptsOff + nPts * 16;
  const recOff = dashOff + nDash * 4;
  const strOff = recOff + words * 4;
  const total = strOff + strBytes;
  if (total > 0xffffffff || nPts > 0xffffffff) throw new Error("Szene zu gross für das Binärformat");

  const buf = new ArrayBuffer(total);
  const bytes = new Uint8Array(buf);
  const hdr = new Uint32Array(buf, 0, HEADER_BYTES / 4);
  const pts = new Float64Array(buf, ptsOff, nPts * 2);
  const dash = new Float32Array(buf, dashOff, nDash);
  const u32 = new Uint32Array(buf, recOff, words);
  const f32 = new Float32Array(buf, recOff, words);

  bytes.set([0x44, 0x52, 0x32, 0x53], 0); // "DR2S"
  hdr[1] = SCENE_BIN_VERSION;
  hdr[2] = fills.length;
  hdr[3] = outlines.length;
  hdr[4] = polylines.length;
  hdr[5] = arcs.length;
  hdr[6] = lines.length;
  hdr[7] = texts.length;
  hdr[8] = nPts;
  hdr[9] = nDash;
  hdr[10] = strBytes;
  hdr[11] = 0;

  let pi = 0; // Index in pts (Doubles)
  let di = 0; // Index in dash
  let w = 0; // Index in u32/f32
  const ring = (a: ArrayLike<readonly [number, number]>) => {
    for (let i = 0; i < a.length; i++) {
      pts[pi++] = a[i][0];
      pts[pi++] = a[i][1];
    }
  };
  const col = (c: readonly number[]) => {
    f32[w++] = c[0];
    f32[w++] = c[1];
    f32[w++] = c[2];
    f32[w++] = c[3];
  };
  const dashes = (d: readonly number[] | null | undefined): number => {
    if (!d || d.length === 0) return 0;
    for (let i = 0; i < d.length; i++) dash[di++] = d[i];
    return d.length;
  };

  for (const f of fills) {
    u32[w++] = f.pts.length;
    u32[w++] = f.z >>> 0;
    col(f.color);
    ring(f.pts);
  }
  for (const o of outlines) {
    u32[w++] = o.pts.length;
    u32[w++] = o.z >>> 0;
    f32[w++] = o.widthMm;
    u32[w++] = dashes(o.dash);
    col(o.color);
    ring(o.pts);
  }
  for (const p of polylines) {
    u32[w++] = p.pts.length;
    u32[w++] = p.z >>> 0;
    f32[w++] = p.widthMm;
    u32[w++] = dashes(p.dash);
    u32[w++] = p.widthScreen ? 1 : 0;
    col(p.color);
    ring(p.pts);
  }
  for (const a of arcs) {
    f32[w++] = a.r;
    f32[w++] = a.widthMm;
    u32[w++] = dashes(a.dash);
    col(a.color);
    pts[pi++] = a.center[0];
    pts[pi++] = a.center[1];
    pts[pi++] = a.from[0];
    pts[pi++] = a.from[1];
    pts[pi++] = a.to[0];
    pts[pi++] = a.to[1];
  }
  for (const l of lines) {
    f32[w++] = l.widthMm;
    u32[w++] = dashes(l.dash);
    u32[w++] = l.z >>> 0;
    col(l.color);
    pts[pi++] = l.a[0];
    pts[pi++] = l.a[1];
    pts[pi++] = l.b[0];
    pts[pi++] = l.b[1];
  }
  let so = 0;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    f32[w++] = t.sizeMm;
    u32[w++] = ALIGN[t.align] ?? 0;
    u32[w++] = so;
    u32[w++] = strs[i].length;
    col(t.color);
    pts[pi++] = t.pos[0];
    pts[pi++] = t.pos[1];
    bytes.set(strs[i], strOff + so);
    so += strs[i].length;
  }
  return bytes;
}
