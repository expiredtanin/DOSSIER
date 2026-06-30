// Node-seitige Geometrie-Prüfung (kein Browser): generiert eine minimale,
// gültige Test-DXF (Höhenlinien auf Z=400/401/402), schickt sie durch parseDxf
// → generateTerrainFromContours und bestätigt ein plausibles TIN.
//
// Die TS-Quellen werden mit esbuild on-the-fly zu einem ESM-Bundle gebaut und
// importiert (kein tsx nötig).

import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = mkdtempSync(join(tmpdir(), "cad-terrain-"));
const outfile = join(outdir, "bundle.mjs");

await build({
  entryPoints: [join(process.cwd(), "scripts/_terrain-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "warning",
});

const mod = await import(pathToFileURL(outfile).href);
const { parseDxf, generateTerrainFromContours } = mod;

// ── Minimal gültige Test-DXF: drei LWPOLYLINE-Höhenlinien (Z via Elevation 38) ──
// Jede Kontur ist ein leicht versetztes Dreieck/Quadrat auf einer eigenen Höhe.
function ring(z, pts, layer) {
  // LWPOLYLINE mit Elevation-Gruppe (38) und 90=Vertex-Zahl, 70=closed(1).
  let s = `0\nLWPOLYLINE\n8\n${layer}\n38\n${z}\n90\n${pts.length}\n70\n1\n`;
  for (const [x, y] of pts) s += `10\n${x}\n20\n${y}\n`;
  return s;
}

const dxf =
  `0\nSECTION\n2\nENTITIES\n` +
  ring(400, [[0, 0], [10, 0], [10, 10], [0, 10]], "contours") +
  ring(401, [[2, 2], [8, 2], [8, 8], [2, 8]], "contours") +
  ring(402, [[4, 4], [6, 4], [6, 6], [4, 6]], "contours") +
  `0\nENDSEC\n0\nEOF\n`;

const parsed = parseDxf(dxf);
const contourSets = parsed.contours;
const allContours = contourSets.flatMap((cs) => cs.contours);

console.log("=== DXF-Parse ===");
console.log("ContourSets:", contourSets.length, "Konturen:", allContours.length);
console.log("Z-Werte:", allContours.map((c) => c.z).join(", "));
console.log("Meshes (importiert):", parsed.meshes.length);

const terrain = generateTerrainFromContours(allContours);
const vertCount = terrain.positions.length / 3;
const triCount = terrain.indices.length / 3;

let minZ = Infinity, maxZ = -Infinity, nan = 0;
for (let i = 0; i < terrain.positions.length; i++) {
  const v = terrain.positions[i];
  if (!Number.isFinite(v)) nan++;
}
for (let i = 2; i < terrain.positions.length; i += 3) {
  minZ = Math.min(minZ, terrain.positions[i]);
  maxZ = Math.max(maxZ, terrain.positions[i]);
}

console.log("\n=== TIN ===");
console.log("Vertices:", vertCount, "Dreiecke:", triCount);
console.log("Z-Range:", minZ, "..", maxZ);
console.log("NaN/Infinity-Werte:", nan);

const ok =
  contourSets.length === 1 &&
  allContours.length === 3 &&
  vertCount > 0 &&
  triCount > 0 &&
  nan === 0 &&
  Math.abs(minZ - 400) < 1e-6 &&
  Math.abs(maxZ - 402) < 1e-6;

// Zusatz: leere Eingabe → leeres Mesh (kein Crash).
const empty = generateTerrainFromContours([]);
const emptyOk = empty.positions.length === 0 && empty.indices.length === 0;
console.log("\nLeere-Eingabe → leeres Mesh:", emptyOk ? "OK" : "FEHLER");

console.log("\n" + (ok && emptyOk ? "✅ TIN plausibel" : "❌ TIN NICHT plausibel"));
process.exit(ok && emptyOk ? 0 : 1);
