import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Rust-Kern (pkgCore) vor jedem Testmodul synchron laden.
    setupFiles: ["src/engine/coreWasm.setup.ts"],
    // Grosszügig: andere Agents bauen/testen parallel, die Maschine ist oft überbucht. Die 5-s-Vorgabe
    // traf dann Tests mit grossen Eingaben (Plan-Chunks, Kern-Chargen), die allein < 1 s laufen.
    // Fehlschläge bleiben Fehlschläge; nur die Wartezeit bis zum Abbruch ist länger.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
