import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  define: { __DOSSIER_VERSION__: JSON.stringify(pkg.version), __DOSSIER_BUILD__: JSON.stringify("000000.0") },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // [273] eigener TMPDIR je Lauf; was Tests liegen lassen, wird nachgezählt und gemeldet.
    globalSetup: ["src/test/tmpGuard.ts"],
    // Rust-Kern (pkgCore) vor jedem Testmodul synchron laden.
    setupFiles: ["src/engine/coreWasm.setup.ts", "src/export/pdfFonts.setup.ts"],
    // Grosszügig: andere Agents bauen/testen parallel, die Maschine ist oft überbucht. Die 5-s-Vorgabe
    // traf dann Tests mit grossen Eingaben (Plan-Chunks, Kern-Chargen), die allein < 1 s laufen.
    // Fehlschläge bleiben Fehlschläge; nur die Wartezeit bis zum Abbruch ist länger.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
