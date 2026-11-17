// [215] Rendering mit dem mitgelieferten Cycles-Programm (Standalone, Apache-2.0; Plan: `doc/CYCLES.md`).
//
// Die Szene schreibt der Rust-Kern (`src-tauri/core/src/cycles_scene.rs`, Abfrage `cyclesScene`): Cycles-XML mit allen
// 3D-Netzen des Modells (gleiche Quelle wie glTF-Export und 3D-Anzeige), Materialien, Kamera, Sonne und Himmel. Dieses Modul
// reicht die Optionen weiter, lädt die Bildkarten (der Kern liest keine Dateien), startet das Programm über einen Gastgeber
// (Node-CLI heute; Tauri/Electron später wie `BlenderHost`), liest den Fortschritt und macht aus dem linearen EXR ein PNG:
// EXR lesen (Zeilenblöcke, unkomprimiert/ZIP, Half/Float) → Tonwert im Kern (`cycles_post.rs`) → PNG.
//
// Das Programm hat keine Tonwert-Abbildung und keine Farbverwaltung (ohne OCIO gebaut): `<film exposure>` der Szene belichtet,
// der Tonwert (Filmic-artig, `filmic`, oder `standard`) liegt hier. Zlib (EXR-ZIP, PNG) kommt vom Gastgeber (`Codec`).

import type { Project } from "../model/types";
import { documentFor } from "../core/document";
import { core } from "../engine/coreWasm";
import type { RenderCamera, RenderViewPreset, TextureLoader } from "./blenderRender";

/** Optionen der Szene (JSON an den Kern, camelCase; `cyclesScene` in `cycles_scene.rs`). */
export interface CyclesSceneOptions {
  width: number;
  height: number;
  samples: number;
  denoise?: boolean;
  /** Zeitpunkt der Sonne (Unix-ms); fehlt er, gilt der 21.6.2026 12:00 UTC. */
  whenMs?: number;
  /** Fester Sonnenstand statt Zeit/Ort. */
  sun?: { azimuth: number; elevation: number };
  sunIntensity?: number;
  /** Belichtung in EV; fehlt sie, belichtet der Kern automatisch nach Sonnenhöhe. */
  exposureEv?: number;
  /** Voreinstellung (rahmt das Gebäude ein) oder explizit (gespeicherte/aktuelle Kamera). */
  camera?: { preset: RenderViewPreset } | RenderCamera;
  /** [227] Gelände ohne Baugrube (Standard: ja). */
  backfilled?: boolean;
  /** Gelände und Kontext (Standard: ja). */
  context?: boolean;
  /** Bodenplatte (Standard: ja). */
  ground?: boolean;
  /** Bild-URLs, die geladen werden können (`undefined` = alle). */
  textures?: string[];
}

/** Antwort des Kerns. */
export interface CyclesSceneInfo {
  xml: string;
  textures: { path: string; url: string }[];
  meshes: number;
  triangles: number;
  width: number;
  height: number;
  samples: number;
  sunAzimuth: number;
  sunElevation: number;
  exposure: number;
  notes: string[];
}

/** Szene mit geladenen Bildkarten: Dateien relativ zu `scene.xml`. */
export interface CyclesPackage {
  info: CyclesSceneInfo;
  /** `scene.xml` und `textures/…`. */
  files: { path: string; bytes: Uint8Array }[];
  missingTextures: string[];
}

/** Szene aus dem Kern (ohne Bilddateien). */
export function cyclesSceneInfo(project: Project, opts: CyclesSceneOptions): CyclesSceneInfo {
  return documentFor(project).query<CyclesSceneInfo>("cyclesScene", [], JSON.stringify(opts));
}

/**
 * Baut das Paket: Szene aus dem Kern, Bildkarten über `loadTexture` (nicht ladbare fallen im zweiten Durchgang auf den
 * Ersatzlook des Kerns zurück, damit die XML keine fehlenden Dateien nennt).
 */
export async function buildCyclesPackage(project: Project, opts: CyclesSceneOptions, loadTexture?: TextureLoader): Promise<CyclesPackage> {
  let info = cyclesSceneInfo(project, opts.textures || !loadTexture ? opts : { ...opts, textures: undefined });
  const bytes = new Map<string, Uint8Array>();
  const missing: string[] = [];
  if (loadTexture) {
    for (const t of info.textures) {
      if (bytes.has(t.url) || missing.includes(t.url)) continue;
      const b = await loadTexture(t.url).catch(() => null);
      if (b && b.length > 0) bytes.set(t.url, b);
      else missing.push(t.url);
    }
    if (missing.length > 0) info = cyclesSceneInfo(project, { ...opts, textures: [...bytes.keys()] });
  } else if (info.textures.length > 0) {
    info = cyclesSceneInfo(project, { ...opts, textures: [] });
  }
  const files: CyclesPackage["files"] = [{ path: "scene.xml", bytes: new TextEncoder().encode(info.xml) }];
  for (const t of info.textures) {
    const b = bytes.get(t.url);
    if (b) files.push({ path: t.path, bytes: b });
  }
  return { info, files, missingTextures: missing };
}

// ── Programm starten, Ausgabe lesen ─────────────────────────────────────────

export type CyclesEvent =
  | { kind: "sample"; done: number; total: number }
  | { kind: "stage"; stage: "scene" | "kernels" | "write" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Eine Ausgabezeile von `cycles` (Fortschritt mit Wagenrücklauf: `Progress 06.25   Sample 1/16`, dazu
 * `Updating …`, `Loading render kernels …`, `Writing image …`, `Finished Rendering.`, Fehler `… | ERROR: …`).
 */
export function parseCyclesLine(line: string): CyclesEvent | null {
  const s = /\bSample\s+(\d+)\s*\/\s*(\d+)/.exec(line);
  if (s) return { kind: "sample", done: Number(s[1]), total: Number(s[2]) };
  const e = /\bERROR:\s*(.*)$/.exec(line);
  if (e) return { kind: "error", message: e[1].trim() };
  if (/Loading (render|denoising) kernels/.test(line)) return { kind: "stage", stage: "kernels" };
  if (/Writing image/.test(line)) return { kind: "stage", stage: "write" };
  if (/Finished Rendering/.test(line)) return { kind: "done" };
  if (/Updating /.test(line)) return { kind: "stage", stage: "scene" };
  return null;
}

/** Aufruf-Gastgeber (Node, später Tauri/Electron): Prozess und Dateisystem. */
export interface CyclesHost {
  /** Pfad des Programms (eigene Angabe, `DOSSIER_CYCLES`, neben der App), oder null. */
  find(custom?: string): Promise<string | null>;
  /** Neuer Arbeitsordner, Dateien hinein, Ordner zurück. */
  prepare(files: { path: string; bytes: Uint8Array }[]): Promise<string>;
  /** Startet das Programm; `onLine` je Ausgabezeile (stdout und stderr, Wagenrücklauf trennt). */
  spawn(exe: string, args: string[], onLine: (line: string) => void): { done: Promise<number>; cancel(): void };
  readFile(path: string): Promise<Uint8Array>;
  join(dir: string, rel: string): string;
}

export class CyclesMissingError extends Error {
  constructor() {
    super("Cycles nicht gefunden");
    this.name = "CyclesMissingError";
  }
}

export class CyclesCancelled extends Error {
  constructor() {
    super("Rendering abgebrochen");
    this.name = "CyclesCancelled";
  }
}

/** Zlib des Gastgebers (Node: `zlib`; Browser: Kompressions-Ströme). */
export interface Codec {
  inflate(data: Uint8Array): Uint8Array;
  deflate(data: Uint8Array): Uint8Array;
}

export interface CyclesRunOptions {
  /** Eigener Programmpfad. */
  cyclesPath?: string;
  /** `CPU` erzwingt die CPU (`--device CPU`); sonst Wahl des Programms. */
  device?: string;
  threads?: number;
  /** Tonwert: `filmic` (Standard) oder `standard`; Zusatzbelichtung in EV. */
  look?: "filmic" | "standard";
  extraEv?: number;
  codec: Codec;
  onProgress?: (e: { fraction: number; stage: string; done: number; total: number }) => void;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface CyclesResult {
  png: Uint8Array;
  /** Rohes lineares Bild des Programms (EXR). */
  exr: Uint8Array;
  width: number;
  height: number;
  dir: string;
  /** Wandzeit von Programmstart bis Ende (ms). */
  millis: number;
  /** Fehler-/Warnzeilen des Programms (leer = sauber). */
  messages: string[];
}

/** Kommandozeile für `cycles`. */
export function cyclesArgs(info: Pick<CyclesSceneInfo, "width" | "height" | "samples">, scenePath: string, outPath: string, o: Pick<CyclesRunOptions, "device" | "threads"> = {}): string[] {
  const a = ["--background", "--samples", String(info.samples), "--width", String(info.width), "--height", String(info.height), "--output", outPath];
  if (o.device) a.push("--device", o.device);
  if (o.threads && o.threads > 0) a.push("--threads", String(Math.round(o.threads)));
  a.push(scenePath);
  return a;
}

/** Paket auspacken, `cycles` laufen lassen, Fortschritt melden, EXR → Tonwert → PNG. */
export async function runCyclesRender(host: CyclesHost, pkg: CyclesPackage, opts: CyclesRunOptions): Promise<CyclesResult> {
  const exe = await host.find(opts.cyclesPath);
  if (!exe) throw new CyclesMissingError();
  const dir = await host.prepare(pkg.files);
  const out = host.join(dir, "render.exr");
  const total = pkg.info.samples;
  const messages: string[] = [];
  const t0 = Date.now();
  let stage = "scene";
  const job = host.spawn(exe, cyclesArgs(pkg.info, host.join(dir, "scene.xml"), out, opts), (line) => {
    opts.onLine?.(line);
    const ev = parseCyclesLine(line);
    if (!ev) return;
    if (ev.kind === "error") messages.push(ev.message);
    else if (ev.kind === "stage") {
      stage = ev.stage;
      opts.onProgress?.({ fraction: 0, stage, done: 0, total });
    } else if (ev.kind === "sample") {
      opts.onProgress?.({ fraction: ev.total > 0 ? Math.min(1, ev.done / ev.total) : 0, stage: "render", done: ev.done, total: ev.total });
    }
  });
  const onAbort = () => job.cancel();
  opts.signal?.addEventListener("abort", onAbort);
  if (opts.signal?.aborted) job.cancel();
  let code: number;
  try {
    code = await job.done;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  if (opts.signal?.aborted) throw new CyclesCancelled();
  const millis = Date.now() - t0;
  if (code !== 0) throw new Error(`Cycles beendet mit Code ${code}${messages.length ? `: ${messages.slice(-3).join(" | ")}` : ""}`);
  const exr = await host.readFile(out).catch(() => null);
  if (!exr || exr.length === 0) throw new Error(messages.length ? `Cycles hat kein Bild geschrieben: ${messages.slice(-3).join(" | ")}` : "Cycles hat kein Bild geschrieben");
  const img = readExr(exr, opts.codec.inflate);
  const png = exrToPng(img, opts.look ?? "filmic", opts.extraEv ?? 0, opts.codec.deflate);
  opts.onProgress?.({ fraction: 1, stage: "done", done: total, total });
  return { png, exr, width: img.width, height: img.height, dir, millis, messages };
}

// ── EXR lesen ───────────────────────────────────────────────────────────────

export interface ExrImage {
  width: number;
  height: number;
  /** RGB, zeilenweise von oben, linear. */
  rgb: Float32Array;
}

/** Half → Float (IEEE 754 binary16). */
function halfToFloat(h: number): number {
  const s = (h & 0x8000) !== 0 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f === 0 ? s * Infinity : NaN;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/**
 * OpenEXR (einteilig, Zeilenblöcke) lesen: Kompression keine/ZIPS/ZIP, Kanäle R, G, B (Half, Float oder UInt32). Anderes (PIZ,
 * Kacheln, mehrteilig) wirft einen Fehler; das Programm schreibt sein EXR mit ZIP und Float.
 */
export function readExr(bytes: Uint8Array, inflate: (d: Uint8Array) => Uint8Array): ExrImage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || dv.getUint32(0, true) !== 0x01312f76) throw new Error("Kein OpenEXR-Bild");
  const flags = dv.getUint32(4, true);
  if (flags & 0x1a00) throw new Error("OpenEXR: Kacheln/mehrteilig/lange Namen werden nicht gelesen");
  let pos = 8;
  const text = new TextDecoder();
  const cstr = (): string => {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    const s = text.decode(bytes.subarray(start, pos));
    pos++;
    return s;
  };
  let channels: { name: string; type: number }[] = [];
  let win: [number, number, number, number] = [0, 0, -1, -1];
  let compression = 0;
  for (;;) {
    const name = cstr();
    if (name === "") break;
    cstr();
    const size = dv.getInt32(pos, true);
    pos += 4;
    const end = pos + size;
    if (name === "channels") {
      let p = pos;
      channels = [];
      while (p < end && bytes[p] !== 0) {
        let q = p;
        while (bytes[q] !== 0) q++;
        const chName = text.decode(bytes.subarray(p, q));
        p = q + 1;
        channels.push({ name: chName, type: dv.getInt32(p, true) });
        p += 16;
      }
    } else if (name === "dataWindow") {
      win = [dv.getInt32(pos, true), dv.getInt32(pos + 4, true), dv.getInt32(pos + 8, true), dv.getInt32(pos + 12, true)];
    } else if (name === "compression") {
      compression = bytes[pos];
    }
    pos = end;
  }
  const width = win[2] - win[0] + 1;
  const height = win[3] - win[1] + 1;
  if (!(width > 0 && height > 0) || width * height > 2 ** 28) throw new Error("OpenEXR: ungültige Bildgrösse");
  if (compression !== 0 && compression !== 2 && compression !== 3) throw new Error(`OpenEXR: Kompression ${compression} wird nicht gelesen (erwartet: keine, ZIPS, ZIP)`);
  const rows = compression === 3 ? 16 : 1;
  const blocks = Math.ceil(height / rows);
  const idx = (n: string) => channels.findIndex((c) => c.name === n);
  const [ri, gi, bi] = [idx("R"), idx("G"), idx("B")];
  if (ri < 0 || gi < 0 || bi < 0) throw new Error("OpenEXR: Kanäle R, G, B fehlen");
  const size = (t: number) => (t === 1 ? 2 : 4);
  const rowBytes = channels.reduce((n, c) => n + width * size(c.type), 0);
  const out = new Float32Array(width * height * 3);
  const table = pos;
  for (let b = 0; b < blocks; b++) {
    const off = Number(dv.getBigUint64(table + b * 8, true));
    const y0 = dv.getInt32(off, true) - win[1];
    const n = dv.getInt32(off + 4, true);
    let raw = bytes.subarray(off + 8, off + 8 + n);
    const lines = Math.min(rows, height - y0);
    const want = rowBytes * lines;
    if (compression !== 0 && n < want) {
      const d = inflate(raw);
      // Vorhersage rückgängig machen, Hälften wieder verschränken.
      const t = new Uint8Array(d.length);
      t[0] = d[0];
      for (let i = 1; i < d.length; i++) t[i] = (t[i - 1] + d[i] - 128) & 255;
      const half = (d.length + 1) >> 1;
      const un = new Uint8Array(d.length);
      for (let i = 0, k = 0; k < half; i += 2, k++) un[i] = t[k];
      for (let i = 1, k = half; k < d.length; i += 2, k++) un[i] = t[k];
      raw = un;
    }
    if (raw.length < want) throw new Error("OpenEXR: Zeilenblock zu kurz");
    const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let q = 0;
    for (let l = 0; l < lines; l++) {
      const y = y0 + l;
      for (let ci = 0; ci < channels.length; ci++) {
        const c = channels[ci];
        const slot = ci === ri ? 0 : ci === gi ? 1 : ci === bi ? 2 : -1;
        const sz = size(c.type);
        if (slot >= 0) {
          for (let x = 0; x < width; x++) {
            const o = q + x * sz;
            out[(y * width + x) * 3 + slot] = c.type === 1 ? halfToFloat(rv.getUint16(o, true)) : c.type === 2 ? rv.getFloat32(o, true) : rv.getUint32(o, true);
          }
        }
        q += width * sz;
      }
    }
  }
  return { width, height, rgb: out };
}

// ── PNG schreiben ───────────────────────────────────────────────────────────

let crcTable: Uint32Array | null = null;
function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = crcTable[(c ^ p[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG (RGB, 8 Bit) aus einem RGB-Puffer; `deflate` = Zlib des Gastgebers. */
export function encodePng(width: number, height: number, rgb: Uint8Array, deflate: (d: Uint8Array) => Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const idat = deflate(raw);
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const t = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(t, 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32([t, data]));
    return out;
  };
  const head = new Uint8Array(13);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  head.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

/** Lineares Bild → Tonwert (Kern) → PNG. */
export function exrToPng(img: ExrImage, look: "filmic" | "standard", extraEv: number, deflate: (d: Uint8Array) => Uint8Array): Uint8Array {
  const rgb8 = core().cycles_tonemap(img.rgb, 3, extraEv, look);
  if (rgb8.length !== img.width * img.height * 3) throw new Error("Tonwert-Abbildung fehlgeschlagen");
  return encodePng(img.width, img.height, rgb8, deflate);
}
