import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Rust-Kern (pkgCore) vor jedem Testmodul synchron laden.
    setupFiles: ["src/engine/coreWasm.setup.ts"],
  },
});
