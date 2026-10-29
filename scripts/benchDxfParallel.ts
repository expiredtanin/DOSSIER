// Misst den DXF-/DWG-Import (Rust-Format-Modul, `src/io/dxfParser.ts`) an einer ECHTEN Datei:
// (1) Einzel-Pass, (2) für grosse ASCII-DXF die parallele Aufteilung (`split.rs`) über echte
// `worker_threads` (Node-Äquivalent der Browser-Worker in `dxfParserAsync.ts`). Korrektheit:
// Gesamtzahlen (Konturen/Texte/Meshes, Zusammenfassung des Kerns) müssen zwischen beiden Läufen IDENTISCH sein.
//
// Lauf: `node scripts/bench-dxf-parallel.mjs <pfad.dxf|pfad.dwg>` (vorher `npm run build:fileio`).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { initFileioSync } from "../src/engine/fileioWasm";
import { initCoreSync } from "../src/engine/coreWasm";
import { importDrawingFlat } from "../src/io/dxfParser";
import { importSummary, packChunks, type ImportChunk, type ImportSummary } from "../src/io/importSource";

const path = process.argv[2];
const workerPath = process.argv[3];
if (!path || !workerPath) {
  console.error("Pfad zur DXF-/DWG-Datei und zum gebündelten Worker-Skript angeben.");
  process.exit(1);
}
const wasmPath = resolve("src/engine/pkgFileIo/fileio_bg.wasm");
const CLOSER = new TextEncoder().encode("0\nENDSEC\n0\nEOF\n");

/** Zahlen der Zusammenfassung (Kern liest die Stücke wie in der App). */
function countAll(chunks: ImportChunk[]) {
  const s: ImportSummary = importSummary(packChunks(chunks));
  return { contours: s.contours, texts: s.texts, meshes: s.meshes, entities: s.diagnostics.total };
}

console.log(`\nImport-Benchmark: ${path}\n`);
const bytes = new Uint8Array(readFileSync(path));
console.log(`  Datei: ${(bytes.length / 1024 / 1024).toFixed(0)} MB\n`);
const t00 = performance.now();
const m = await initFileioSync(readFileSync(wasmPath));
initCoreSync(readFileSync(resolve("src/engine/pkgCore/core_bg.wasm")));
console.log(`  Modul laden:    ${(performance.now() - t00).toFixed(0).padStart(7)} ms`);

// Erster Lauf wärmt die WASM-Engine auf (Tier-up von Liftoff auf TurboFan) — gemessen wird beides.
const tw = performance.now();
importDrawingFlat(bytes);
console.log(`  Erster Lauf:    ${(performance.now() - tw).toFixed(0).padStart(7)} ms (kalt)`);
const t0 = performance.now();
const flat = importDrawingFlat(bytes);
const tRust = performance.now();
const singleCounts = countAll([flat]);
const singleMs = performance.now() - t0;
console.log(
  `  Einzel-Pass:    ${singleMs.toFixed(0).padStart(7)} ms  (Lesen ${(tRust - t0).toFixed(0)} ms, Kern-Zusammenfassung ${(t0 + singleMs - tRust).toFixed(0)} ms)`,
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
const merged = countAll(results.map((r) => ({ geom: r.geom, strings: r.strings })));
const parallelMs = performance.now() - t1;
for (const [i, r] of results.entries()) {
  console.log(
    `    Worker ${i}: Start→Modul ${(r.tGotInput - spawned[i]).toFixed(0)} ms, Rust ${(r.tParsed - r.tGotInput).toFixed(0)} ms`,
  );
}
console.log(`  Parallel (${chunks.length} Worker): ${(parallelMs + splitMs).toFixed(0).padStart(7)} ms inkl. Scan  `, merged);
const ok =
  merged.contours === singleCounts.contours && merged.texts === singleCounts.texts && merged.meshes === singleCounts.meshes;
console.log(`\n  Korrektheit: ${ok ? "IDENTISCH ✓" : "ABWEICHUNG ✗"}`);
console.log(`  Speedup:     ${(singleMs / (parallelMs + splitMs)).toFixed(2)}x\n`);
if (!ok) process.exit(1);
