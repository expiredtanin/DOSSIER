// Bundlet scripts/dumpNativeScene.ts mit esbuild für Node und führt es aus.
// So läuft die echte TS-Modellpipeline (generatePlan) headless, ohne tsx.
import esbuild from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const out = resolve(tmpdir(), `dump-native-scene.${process.pid}.mjs`);

await esbuild.build({
  entryPoints: ["scripts/dumpNativeScene.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: out,
  logLevel: "warning",
});

await import(pathToFileURL(out).href);
