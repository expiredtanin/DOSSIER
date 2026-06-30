// Bündel-Einstieg für check-terrain.mjs — re-exportiert die zu testenden
// Funktionen, damit esbuild ein einzelnes ESM-Bundle bauen kann.
export { parseDxf } from "../src/io/dxfParser";
export { generateTerrainFromContours } from "../src/model/terrain";
