// Bündelt scripts/benchDxfParallel.ts + benchDxfParallelWorker.ts mit esbuild
// für Node und führt den Hauptteil aus (echte Parallelität über worker_threads).
// Lauf: `node scripts/bench-dxf-parallel.mjs <pfad.dxf|pfad.dwg>` (vorher `npm run build:fileio`).
import esbuild from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const mainOut = resolve(tmpdir(), `bench-dxf-parallel-main.${process.pid}.mjs`);
const workerOut = resolve(tmpdir(), `bench-dxf-parallel-worker.${process.pid}.mjs`);

await esbuild.build({
  entryPoints: ["scripts/benchDxfParallelWorker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: workerOut,
  logLevel: "warning",
});

await esbuild.build({
  entryPoints: ["scripts/benchDxfParallel.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: mainOut,
  logLevel: "warning",
});

process.argv[3] = workerOut;
await import(pathToFileURL(mainOut).href);
