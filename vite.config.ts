import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const { buildCsp } = createRequire(import.meta.url)("./scripts/csp.cjs") as { buildCsp: () => string };
// [261] Version (package.json) und Buildnummer JJMMTT.N (scripts/build-number.cjs) in die Oberfläche einbacken.
const { computeBuildNumber } = createRequire(import.meta.url)("./scripts/build-number.cjs") as { computeBuildNumber: () => string };
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// [117] CSP nur im Build (Meta-Tag): der Dev-Server braucht Inline-Skripte für HMR/React-Refresh.
const cspPlugin = {
  name: "dossier-csp",
  apply: "build" as const,
  transformIndexHtml: () => [
    { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: buildCsp() }, injectTo: "head-prepend" as const },
  ],
};

// [261][170] Buildnummer einmal berechnen: eingebacken in die Oberfläche und als `dist/build-info.json` für das
// Linux-Paket (`scripts/electron-pack.cjs`), damit beide dieselbe Nummer tragen.
const BUILD = computeBuildNumber();
const buildInfoPlugin = {
  name: "dossier-build-info",
  apply: "build" as const,
  generateBundle(this: { emitFile: (f: { type: "asset"; fileName: string; source: string }) => void }) {
    this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify({ version: pkg.version, build: BUILD }) + "\n" });
  },
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), cspPlugin, buildInfoPlugin],
  define: { __DOSSIER_VERSION__: JSON.stringify(pkg.version), __DOSSIER_BUILD__: JSON.stringify(BUILD) },
  // Tauri lädt die App über den Vite-Dev-Server; dessen Logs (cargo/tauri)
  // sollen nicht vom Bildschirm gewischt werden, und Tauri-eigene Env-Vars
  // müssen im Client sichtbar sein.
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // Import-Worker (`io/dxfParser.worker.ts`) laden das Format-Modul per dynamischem import() —
  // das braucht ES-Module-Worker (Code-Splitting); erzeugt werden sie mit `{ type: "module" }`.
  worker: { format: "es" },
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
