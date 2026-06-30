// Node-Laufzeittest für den echten DWG-Import-Pfad (LibreDWG-WASM).
//
// Bündelt src/io/dwgParser.ts (samt Model-Typen) per esbuild zu einem ESM-Modul
// und ruft parseDwg() mit echten DWG-Beispieldateien auf. Loggt die erkannten
// Konturen/Meshes — spiegelt damit exakt das, was der Import-Dialog anzeigen
// würde (dieselbe parseDwg-Funktion, die auch der Browser-Import nutzt).
//
// Aufruf:  node scripts/probe-dwg.mjs [pfad/zur.dwg ...]
// Ohne Argumente werden einige bekannte System-Beispiele probiert.

import { build } from "esbuild";
import { readFile, writeFile, unlink, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// parseDwg + Abhängigkeiten zu einem temporären ESM-Bundle backen. WASM-Lib
// bleibt extern (wird zur Laufzeit aus node_modules geladen → echtes WASM).
const outFile = resolve(root, "scripts/_dwgparser.bundle.mjs");
await build({
  entryPoints: [resolve(root, "src/io/dwgParser.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
  external: ["@mlightcad/libredwg-web"],
  logLevel: "warning",
});

const { parseDwg } = await import(outFile + "?t=" + Date.now());

const candidates =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        "/home/karim/Downloads/02-15-cad-blocks-net-bushes-elevation.dwg",
        "/home/karim/ssd/Nextcloud2 (Copy)/00.2 Situation Fluhmatt Bodengeschosse.dwg",
        "/tmp/probe.dwg",
      ];

let anyOk = false;
for (const path of candidates) {
  try {
    await access(path);
  } catch {
    console.log(`SKIP (nicht gefunden): ${path}`);
    continue;
  }
  try {
    const buf = await readFile(path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const t0 = Date.now();
    const res = await parseDwg(ab);
    const dt = Date.now() - t0;
    const contourSets = res.contours;
    const contourCount = contourSets.reduce(
      (s, set) => s + set.contours.length,
      0,
    );
    const layers = new Set();
    for (const set of contourSets)
      for (const c of set.contours) if (c.layer) layers.add(c.layer);
    const triCount = res.meshes.reduce((s, m) => s + m.indices.length / 3, 0);
    console.log(`\nOK  ${path}  (${dt} ms)`);
    console.log(`    Konturen-Sätze: ${contourSets.length}`);
    console.log(`    Konturen:       ${contourCount}`);
    console.log(`    Meshes:         ${res.meshes.length} (${triCount} Dreiecke)`);
    console.log(
      `    Layer:          ${
        layers.size ? [...layers].slice(0, 12).join(", ") : "(keine)"
      }`,
    );
    // Beispiel-Kontur (erste mit ≥2 Punkten) ausgeben.
    const sample = contourSets
      .flatMap((s) => s.contours)
      .find((c) => c.pts.length >= 2);
    if (sample) {
      console.log(
        `    Beispiel-Kontur: ${sample.pts.length} Pkt, closed=${sample.closed}, z=${sample.z}, layer=${sample.layer ?? "-"}`,
      );
    }
    anyOk = true;
  } catch (err) {
    console.log(`\nFEHLER ${path}:`, err?.message ?? err);
  }
}

await unlink(outFile).catch(() => {});

if (!anyOk) {
  console.log("\nKeine DWG erfolgreich gelesen.");
  process.exit(1);
}
