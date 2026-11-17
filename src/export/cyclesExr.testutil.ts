// [215] Test-Hilfe: kleines OpenEXR (B, G, R als Float, ZIP oder unkomprimiert) in der Form, die `cycles` schreibt.
import { deflateSync } from "node:zlib";

/** Kleines OpenEXR (B, G, R als Float, wie das Programm; ZIP oder unkomprimiert) für die Tests. */
export function makeExr(width: number, height: number, rgb: Float32Array, zip: boolean): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0];
  const str = (s: string) => parts.push(...enc.encode(s), 0);
  const i32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const attr = (name: string, type: string, body: number[]) => {
    str(name);
    str(type);
    i32(body.length);
    parts.push(...body);
  };
  const chBody: number[] = [];
  for (const n of ["B", "G", "R"]) chBody.push(...enc.encode(n), 0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
  chBody.push(0);
  attr("channels", "chlist", chBody);
  attr("compression", "compression", [zip ? 3 : 0]);
  const le = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  attr("dataWindow", "box2i", [...le(0), ...le(0), ...le(width - 1), ...le(height - 1)]);
  attr("displayWindow", "box2i", [...le(0), ...le(0), ...le(width - 1), ...le(height - 1)]);
  parts.push(0);
  const rows = zip ? 16 : 1;
  const blocks = Math.ceil(height / rows);
  const data: Uint8Array[] = [];
  for (let b = 0; b < blocks; b++) {
    const lines = Math.min(rows, height - b * rows);
    const raw = new Uint8Array(lines * width * 12);
    const dv = new DataView(raw.buffer);
    let q = 0;
    for (let l = 0; l < lines; l++) {
      for (const slot of [2, 1, 0]) for (let x = 0; x < width; x++, q += 4) dv.setFloat32(q, rgb[((b * rows + l) * width + x) * 3 + slot], true);
    }
    let body = raw;
    if (zip) {
      const half = (raw.length + 1) >> 1;
      const re = new Uint8Array(raw.length);
      for (let i = 0, k = 0; i < raw.length; i += 2, k++) re[k] = raw[i];
      for (let i = 1, k = half; i < raw.length; i += 2, k++) re[k] = raw[i];
      const delta = new Uint8Array(raw.length);
      delta[0] = re[0];
      for (let i = 1; i < re.length; i++) delta[i] = (re[i] - re[i - 1] + 128 + 256) & 255;
      body = new Uint8Array(deflateSync(delta));
    }
    const head = new Uint8Array(8);
    new DataView(head.buffer).setInt32(0, b * rows, true);
    new DataView(head.buffer).setInt32(4, body.length, true);
    data.push(head, body);
  }
  const tableStart = parts.length;
  let off = tableStart + blocks * 8;
  const table = new Uint8Array(blocks * 8);
  const tv = new DataView(table.buffer);
  for (let b = 0; b < blocks; b++) {
    tv.setBigUint64(b * 8, BigInt(off), true);
    off += data[b * 2].length + data[b * 2 + 1].length;
  }
  return Uint8Array.from([...parts, ...table, ...data.flatMap((d) => [...d])]);
}

