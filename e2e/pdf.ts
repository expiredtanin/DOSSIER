// Gemeinsame PDF-/PNG-Helfer der e2e-Specs (Wettbewerb [208], Referenz-Ablauf [206]).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

/** PNG (Verlauf, Standard 160 × 90 px), im Test erzeugt: kein Fixture, nur die Pflicht-Chunks. */
export function testPng(w = 160, h = 90): Buffer {
  const crc = (buf: Buffer): number => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // Bits
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = Math.round((x / w) * 200);
      raw[row + 2 + x * 3] = Math.round(120 + (y / h) * 100);
      raw[row + 3 + x * 3] = 200 - Math.round((y / h) * 120);
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Sichtbarer Text des PDFs (`pdftotext`, Poppler). Die eingebetteten Schriften ([208]) kodieren Text als Glyphen-
 * Nummern (Identity-H), er steht nicht mehr als `(Text)` im Inhaltsstrom; ohne Poppler leer.
 */
export function pdfText(buf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "dossier-e2e-pdf-"));
  try {
    const file = join(dir, "t.pdf");
    writeFileSync(file, buf);
    const r = spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout : "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Text aller Inhaltsströme eines PDFs (Flate entpackt) plus der sichtbare Text (`pdfText`, ohne Klammern). */
export function pdfStreams(buf: Buffer): string {
  const src = buf.toString("latin1");
  let out = src;
  for (const m of src.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      out += inflateSync(buf.subarray(start, end)).toString("latin1");
    } catch {
      /* kein Flate-Strom */
    }
  }
  return out + "\n" + pdfText(buf);
}

