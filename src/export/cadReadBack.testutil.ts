// Test-Hilfen für den DXF-/DWG-Export ([C1]/[C2]): exportierte Dateien UNABHÄNGIG von acadrust
// zurücklesen und inhaltlich vergleichen.
//   - DXF: kleiner Gruppen-Code-Leser (Paare Code/Wert, nur ENTITIES und LAYER-Tabelle). Bewusst
//     nicht der Import (`io/dxfParser`), damit Export-Tests nicht an dessen Umbau hängen.
//   - DWG: libredwg (`@mlightcad/libredwg-web`, reine Test-Abhängigkeit als unabhängiger Gegenleser — die App liest DWG über acadrust) direkt in Node.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Eine Entität, wie sie im DXF steht: Typ, Ebene, alle Gruppen-Codes in Reihenfolge. */
export interface DxfEntity {
  type: string;
  layer: string;
  codes: Array<[number, string]>;
}

/** Erster Wert eines Gruppen-Codes als Zahl (exakt geparst, f64). */
export function num(e: DxfEntity, code: number): number {
  const v = e.codes.find(([c]) => c === code);
  if (!v) throw new Error(`${e.type}: Code ${code} fehlt`);
  return Number(v[1]);
}

/** Alle Werte eines Gruppen-Codes als Zahlen (z. B. 10/20 einer LWPOLYLINE). */
export function nums(e: DxfEntity, code: number): number[] {
  return e.codes.filter(([c]) => c === code).map(([, v]) => Number(v));
}

/** Erster Wert eines Gruppen-Codes als Text. */
export function str(e: DxfEntity, code: number): string | undefined {
  return e.codes.find(([c]) => c === code)?.[1];
}

/** Liest ein ASCII-DXF: Version, Ebenen (Name → Codes) und die Entitäten der ENTITIES-Sektion. */
export function readDxf(text: string): {
  version: string;
  layers: Map<string, DxfEntity>;
  entities: DxfEntity[];
} {
  const lines = text.split(/\r?\n/);
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([Number(lines[i].trim()), lines[i + 1]]);
  let version = "";
  const layers = new Map<string, DxfEntity>();
  const entities: DxfEntity[] = [];
  let section = "";
  let table = "";
  let cur: DxfEntity | null = null;
  const flush = () => {
    if (!cur) return;
    if (section === "ENTITIES") entities.push(cur);
    else if (section === "TABLES" && table === "LAYER" && cur.type === "LAYER") layers.set(str(cur, 2) ?? "", cur);
    cur = null;
  };
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 9 && v === "$ACADVER") version = pairs[i + 1][1].trim();
    if (c !== 0) {
      cur?.codes.push([c, v]);
      if (cur && c === 8) cur.layer = v;
      continue;
    }
    flush();
    if (v === "SECTION") section = pairs[i + 1][1];
    else if (v === "ENDSEC") section = "";
    else if (v === "TABLE") table = pairs[i + 1][1];
    else if (v === "ENDTAB") table = "";
    else cur = { type: v, layer: "", codes: [] };
  }
  flush();
  return { version, layers, entities };
}

/** Zählt Entitäten je Typ. */
export function countByType(entities: Array<{ type: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entities) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

// ── DWG über libredwg ──────────────────────────────────────────────────────

/** Schmale Sicht auf das, was `convert()` von libredwg-web liefert. */
export interface LibreDwgDb {
  entities: Array<{
    type: string;
    layer: string;
    text?: string;
    startPoint?: { x: number; y: number };
    endPoint?: { x: number; y: number };
    center?: { x: number; y: number };
    radius?: number;
    vertices?: Array<{ x: number; y: number }>;
  }>;
  tables: { LAYER: { entries: Array<{ name: string; color: number; lineweight: number }> } };
}

let libredwg: Promise<(bytes: Uint8Array) => LibreDwgDb> | null = null;

/** Lädt libredwg-web (Emscripten) in Node und liefert einen DWG-Leser. */
export function libreDwgReader(): Promise<(bytes: Uint8Array) => LibreDwgDb> {
  libredwg ??= (async () => {
    const base = join(process.cwd(), "node_modules", "@mlightcad", "libredwg-web");
    const glue = (await import(/* @vite-ignore */ pathToFileURL(join(base, "wasm", "libredwg-web.js")).href)).default;
    const { LibreDwg } = await import(/* @vite-ignore */ pathToFileURL(join(base, "dist", "libredwg-web.js")).href);
    const wasmBinary = readFileSync(join(base, "wasm", "libredwg-web.wasm"));
    const inst = await glue({ wasmBinary, locateFile: () => join(base, "wasm", "libredwg-web.wasm") });
    const lib = LibreDwg.createByWasmInstance(inst);
    return (bytes: Uint8Array) => {
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const data = lib.dwg_read_data(buf, 0);
      if (data == null) throw new Error("libredwg: DWG nicht lesbar");
      const db = lib.convert(data) as LibreDwgDb;
      lib.dwg_free(data);
      return db;
    };
  })();
  return libredwg;
}
