import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// @mlightcad/libredwg-web gibt seine WASM-Glue + .wasm im `wasm/`-Ordner aus,
// stellt diese Tiefenpfade aber NICHT über das `exports`-Feld bereit. Daher
// mappen wir zwei virtuelle Module direkt auf die echten Dateien im Paket:
//   • virtual:libredwg-glue     → Emscripten-Glue (createModule)
//   • virtual:libredwg-wasm-url → die .wasm als URL-Asset (?url)
// So bündelt Vite die WASM korrekt (Dev mit richtigem MIME, Build als Asset).
const gluePath = fileURLToPath(
  new URL(
    "./node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.js",
    import.meta.url,
  ),
);
const wasmPath = fileURLToPath(
  new URL(
    "./node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm",
    import.meta.url,
  ),
);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "virtual:libredwg-glue": gluePath,
      "virtual:libredwg-wasm-url": wasmPath + "?url",
    },
  },
  server: {
    host: true,
  },
});
