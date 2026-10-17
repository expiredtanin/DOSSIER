// Node-`worker_threads`-Pendant zu `dxfParser.worker.ts`, NUR für das
// Benchmark-Skript `benchDxfParallel.ts` — misst echten Wall-Clock-Gewinn
// durch mehrere Kerne (die Browser-`Worker`-API gibt es in Node nicht,
// `worker_threads` ist das Äquivalent für diesen Nebenzweck).
import { parentPort, workerData } from "node:worker_threads";
import { parseDxf } from "../src/io/dxfParser";

const tStart = performance.now();
const { text, idPrefix } = workerData as { text: string; idPrefix: string };
const tGotInput = performance.now();
const result = parseDxf(text, idPrefix);
const tParsed = performance.now();
parentPort!.postMessage({ result, tStart, tGotInput, tParsed, tPosted: performance.now() });
