import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
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
