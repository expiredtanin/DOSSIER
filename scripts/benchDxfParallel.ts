// Misst den DXF-/DWG-Import (Rust-Format-Modul, `src/io/dxfParser.ts`) an einer ECHTEN Datei:
// (1) Einzel-Pass, (2) für grosse ASCII-DXF die parallele Aufteilung (`split.rs`) über echte
// `worker_threads` (Node-Äquivalent der Browser-Worker in `dxfParserAsync.ts`). Korrektheit:
// Gesamtzahlen (Konturen/Punkte/Texte/Meshes) müssen zwischen beiden Läufen IDENTISCH sein.
//
// Lauf: `node scripts/bench-dxf-parallel.mjs <pfad.dxf|pfad.dwg>` (vorher `npm run build:fileio`).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { initFileioSync } from "../src/engine/fileioWasm";
import { decodeImport, importDrawingFlat } from "../src/io/dxfParser";
import type { DxfImportResult } from "../src/io/dxfParser";

const path = process.argv[2];
const workerPath = process.argv[3];
if (!path || !workerPath) {
  console.error("Pfad zur DXF-/DWG-Datei und zum gebündelten Worker-Skript angeben.");
  process.exit(1);
}
const wasmPath = resolve("src/engine/pkgFileIo/fileio_bg.wasm");
const CLOSER = new TextEncoder().encode("0\nENDSEC\n0\nEOF\n");

function countAll(res: DxfImportResult) {
  let contours = 0;
  let points = 0;
  for (const set of res.contours) {
    for (const c of set.contours) {
      contours++;
      points += c.pts.length;
    }
  }
  return { contours, points, texts: res.texts?.length ?? 0, meshes: res.meshes.length };
}

console.log(`\nImport-Benchmark: ${path}\n`);
const bytes = new Uint8Array(readFileSync(path));
console.log(`  Datei: ${(bytes.length / 1024 / 1024).toFixed(0)} MB\n`);
const t00 = performance.now();
const m = await initFileioSync(readFileSync(wasmPath));
console.log(`  Modul laden:    ${(performance.now() - t00).toFixed(0).padStart(7)} ms`);

// Erster Lauf wärmt die WASM-Engine auf (Tier-up von Liftoff auf TurboFan) — gemessen wird beides.
const tw = performance.now();
importDrawingFlat(bytes);
console.log(`  Erster Lauf:    ${(performance.now() - tw).toFixed(0).padStart(7)} ms (kalt)`);
const t0 = performance.now();
const flat = importDrawingFlat(bytes);
const tRust = performance.now();
const single = decodeImport(flat.geom, flat.strings);
const singleMs = performance.now() - t0;
const singleCounts = countAll(single);
console.log(
  `  Einzel-Pass:    ${singleMs.toFixed(0).padStart(7)} ms  (Rust ${(tRust - t0).toFixed(0)} ms, Dekodieren ${(performance.now() - tRust).toFixed(0)} ms)`,
  singleCounts,
);

const chunkCount = 4;
const tSplit = performance.now();
const offsets = Array.from(m.dxf_split_offsets(bytes, chunkCount));
const splitMs = performance.now() - tSplit;
if (offsets.length < 3) {
  console.log("\n  Keine Aufteilung (zu klein, Binär-DXF/DWG oder keine ENTITIES-Sektion) — kein Parallel-Lauf.\n");
  process.exit(0);
}
const preamble = bytes.subarray(0, offsets[0]);
const chunks: Uint8Array[] = [];
for (let i = 0; i + 1 < offsets.length; i++) {
  const body = bytes.subarray(offsets[i], offsets[i + 1]);
  const c = new Uint8Array(preamble.length + body.length + CLOSER.length);
  c.set(preamble, 0);
  c.set(body, preamble.length);
  c.set(CLOSER, preamble.length + body.length);
  chunks.push(c);
}
console.log(`\n  Aufgeteilt in ${chunks.length} Stücke (Scan ${splitMs.toFixed(0)} ms).\n`);

const t1 = performance.now();
const spawned: number[] = [];
type Msg = { geom: Float64Array; strings: string[]; tGotInput: number; tParsed: number; tPosted: number };
const results = await Promise.all(
  chunks.map(
    (data, i) =>
      new Promise<Msg>((res, rej) => {
        spawned[i] = performance.now();
        const w = new Worker(workerPath, { workerData: { data, wasmPath } });
        w.once("message", (msg: Msg) => {
          w.terminate();
          res(msg);
        });
        w.once("error", rej);
      }),
  ),
);
const decoded = results.map((r, i) => decodeImport(r.geom, r.strings, `c${i}-`));
const parallelMs = performance.now() - t1;
for (const [i, r] of results.entries()) {
  console.log(
    `    Worker ${i}: Start→Modul ${(r.tGotInput - spawned[i]).toFixed(0)} ms, Rust ${(r.tParsed - r.tGotInput).toFixed(0)} ms`,
  );
}
const merged = decoded.reduce(
  (a, r) => {
    const c = countAll(r);
    return { contours: a.contours + c.contours, points: a.points + c.points, texts: a.texts + c.texts, meshes: a.meshes + c.meshes };
  },
  { contours: 0, points: 0, texts: 0, meshes: 0 },
);
console.log(`  Parallel (${chunks.length} Worker): ${(parallelMs + splitMs).toFixed(0).padStart(7)} ms inkl. Scan  `, merged);
const ok =
  merged.contours === singleCounts.contours &&
  merged.points === singleCounts.points &&
  merged.texts === singleCounts.texts;
console.log(`\n  Korrektheit: ${ok ? "IDENTISCH ✓" : "ABWEICHUNG ✗"}`);
console.log(`  Speedup:     ${(singleMs / (parallelMs + splitMs)).toFixed(2)}x\n`);
if (!ok) process.exit(1);
