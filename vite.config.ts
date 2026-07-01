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

// opencascade.js (Welle-C-HLR-Spike) verpackt Emscripten-Glue + `.wasm` in
// `dist/`, ohne sinnvolle `exports`. Analog zu LibreDWG mappen wir zwei
// virtuelle Module auf die echten Dateien, damit Vite die (große) WASM als
// gehashtes Asset ausgibt (Dev mit korrektem MIME, Build als Asset). Der Import
// im Code ist dynamisch → die WASM bleibt aus dem Haupt-Bundle heraus.
const occtGluePath = fileURLToPath(
  new URL(
    "./node_modules/opencascade.js/dist/opencascade.wasm.js",
    import.meta.url,
  ),
);
const occtWasmPath = fileURLToPath(
  new URL(
    "./node_modules/opencascade.js/dist/opencascade.wasm.wasm",
    import.meta.url,
  ),
);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri lädt die App über den Vite-Dev-Server; dessen Logs (cargo/tauri)
  // sollen nicht vom Bildschirm gewischt werden, und Tauri-eigene Env-Vars
  // müssen im Client sichtbar sein.
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  resolve: {
    alias: {
      "virtual:libredwg-glue": gluePath,
      "virtual:libredwg-wasm-url": wasmPath + "?url",
      "virtual:occt-glue": occtGluePath,
      "virtual:occt-wasm-url": occtWasmPath + "?url",
    },
  },
  // Emscripten-Glue nicht vor-bündeln (esbuild kommt mit dem UMD-Wrapper +
  // Node-Shims nicht klar); der dynamische Import lädt sie zur Laufzeit.
  optimizeDeps: {
    exclude: ["opencascade.js"],
  },
  server: {
    host: true,
    // Fester Port für die Tauri-Integration (tauri.conf.json zeigt hierauf).
    port: 5187,
    strictPort: true,
    // ambientCG-Proxy: Die Such-JSON (`/api/...`) und der Download-Starter
    // (`/get`, ein 302-Redirect) senden KEINE CORS-Header und sind daher aus
    // dem Browser nicht direkt abrufbar. Der Dev-Proxy reicht `/ambientcg/*`
    // an `https://ambientcg.com` durch (Redirects werden gefolgt), sodass der
    // Live-Browse ohne separaten Server funktioniert. Für Prod eine analoge
    // Proxy-Route bereitstellen und via `VITE_AMBIENTCG_PROXY` konfigurieren.
    proxy: {
      "/ambientcg": {
        target: "https://ambientcg.com",
        changeOrigin: true,
        followRedirects: true,
        rewrite: (path: string) => path.replace(/^\/ambientcg/, ""),
      },
    },
  },
});
