// Node-`worker_threads`-Pendant zu `dxfParser.worker.ts`, NUR für das Benchmark-Skript
// `benchDxfParallel.ts` — misst echten Wall-Clock-Gewinn durch mehrere Kerne. Liest ein Stück über
// das Rust-Format-Modul und schickt den flachen Puffer (übertragen) zurück.
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { initFileioSync } from "../src/engine/fileioWasm";
import { importDrawingFlat } from "../src/io/dxfParser";

const tStart = performance.now();
const { data, wasmPath } = workerData as { data: Uint8Array; wasmPath: string };
await initFileioSync(readFileSync(wasmPath));
const tGotInput = performance.now();
const { geom, strings } = importDrawingFlat(data);
const tParsed = performance.now();
parentPort!.postMessage({ geom, strings, tStart, tGotInput, tParsed, tPosted: performance.now() }, [geom.buffer]);
