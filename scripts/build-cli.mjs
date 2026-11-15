// [261] CLI-Bundle mit eingebackener Version + Buildnummer (`npm run build:cli`); sonst wie vorher: esbuild → dist-cli/dossier-cli.mjs.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const { computeBuildNumber } = createRequire(import.meta.url)("./build-number.cjs");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
await build({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-cli/dossier-cli.mjs",
  logLevel: "warning",
  define: { __DOSSIER_VERSION__: JSON.stringify(pkg.version), __DOSSIER_BUILD__: JSON.stringify(computeBuildNumber()) },
});
