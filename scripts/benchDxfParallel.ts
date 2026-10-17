// Misst die parallele Chunk-Aufteilung (`dxfEntityChunker.ts`) gegen eine
// ECHTE DXF-Datei: (1) Korrektheit — Gesamtzahlen (Konturen/Punkte/Texte/
// Meshes) müssen zwischen Einzel-Pass und Chunk-Parallel-Pass IDENTISCH
// sein; (2) Wall-Clock-Gewinn über echte `worker_threads` (Node-Äquivalent
// der Browser-`Worker`-API, die im Produktionscode genutzt wird).
//
// Lauf: `node scripts/bench-dxf-parallel.mjs <pfad.dxf> [workerPfad]`

import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { parseDxf } from "../src/io/dxfParser";
import { splitDxfForParallelParse, DXF_CHUNK_CLOSER } from "../src/io/dxfEntityChunker";

const path = process.argv[2];
const workerPath = process.argv[3];
if (!path || !workerPath) {
  console.error("Pfad zur DXF-Datei und zum gebündelten Worker-Skript angeben.");
  process.exit(1);
}

function countAll(res: { contours: { contours: { pts: unknown[] }[] }[]; texts?: unknown[]; meshes: unknown[] }) {
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

console.log(`\nParallel-Benchmark: ${path}\n`);
const text = readFileSync(path, "utf8");
console.log(`  Datei: ${(text.length / 1024 / 1024).toFixed(0)} MB Text\n`);

const t0 = performance.now();
const single = parseDxf(text);
const singleMs = performance.now() - t0;
const singleCounts = countAll(single);
console.log(`  Einzel-Pass:    ${singleMs.toFixed(0).padStart(7)} ms  `, singleCounts);

const chunkCount = Math.min(4, 8);
const split = splitDxfForParallelParse(text, chunkCount);
if (!split) {
  console.log("\n  splitDxfForParallelParse lieferte null (Datei zu klein oder keine ENTITIES-Sektion) — kein Parallel-Lauf möglich.\n");
  process.exit(0);
}
console.log(`\n  Aufgeteilt in ${split.chunks.length} Chunks.\n`);

for (const [i, chunk] of split.chunks.entries()) {
  console.log(`    Chunk ${i}: ${(chunk.length / 1024 / 1024).toFixed(1)} MB`);
}

const t1 = performance.now();
const spawned: number[] = [];
const results = await Promise.all(
  split.chunks.map(
    (chunk, i) =>
      new Promise((resolve, reject) => {
        spawned[i] = performance.now();
        const w = new Worker(workerPath, {
          workerData: { text: split.preamble + chunk + DXF_CHUNK_CLOSER, idPrefix: `c${i}-` },
        });
        w.once("message", (msg) => {
          w.terminate();
          resolve(msg);
        });
        w.once("error", reject);
      }),
  ),
);
const parallelMs = performance.now() - t1;

for (const [i, r] of (results as any[]).entries()) {
  console.log(
    `    Worker ${i}: Erzeugung→Input ${(r.tGotInput - spawned[i]).toFixed(0)} ms, ` +
      `Parse ${(r.tParsed - r.tGotInput).toFixed(0)} ms, ` +
      `(Nachricht gesendet bei t+${(r.tPosted - t1).toFixed(0)} ms)`,
  );
}

type Res = { contours: { contours: { pts: unknown[] }[] }[]; texts?: unknown[]; meshes: unknown[] };
const mergedContours = [];
const mergedTexts = [];
const mergedMeshes = [];
for (const { result: r } of results as { result: Res }[]) {
  for (const c of r.contours) mergedContours.push(c);
  for (const t of r.texts ?? []) mergedTexts.push(t);
  for (const m of r.meshes) mergedMeshes.push(m);
}
const merged = countAll({ contours: mergedContours, texts: mergedTexts, meshes: mergedMeshes });
console.log(`  Parallel (${split.chunks.length} Worker): ${parallelMs.toFixed(0).padStart(7)} ms  `, merged);

const ok =
  merged.contours === singleCounts.contours &&
  merged.points === singleCounts.points &&
  merged.texts === singleCounts.texts &&
  merged.meshes === singleCounts.meshes;
console.log(`\n  Korrektheit: ${ok ? "IDENTISCH ✓" : "ABWEICHUNG ✗"}`);
console.log(`  Speedup:     ${(singleMs / parallelMs).toFixed(2)}x\n`);
if (!ok) process.exit(1);
