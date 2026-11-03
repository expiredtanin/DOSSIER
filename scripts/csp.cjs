// Content-Security-Policy ([117]) — eine Quelle für Electron (Header), Vite-Build (Meta-Tag, damit
// `vite preview`/die e2e-Suite sie ausübt) und die Prüfung gegen `src-tauri/tauri.conf.json`
// (`src/net/csp.test.ts`; Tauri braucht den Text wörtlich in der JSON-Datei).
// Hosts = `ALLOWED_HOSTS` aus `src/net/net.ts` (der Test gleicht ab).

const NET_HOSTS = [
  "ambientcg.com",
  "api.ambientcg.com",
  "geo.admin.ch",
  "api3.geo.admin.ch",
  "wms.geo.admin.ch",
  "data.geo.admin.ch",
  "overpass-api.de",
  "nominatim.openstreetmap.org",
];

const https = NET_HOSTS.map((h) => `https://${h}`);
// Icon-Font (index.html): Stylesheet von fonts.googleapis.com, Schrift von fonts.gstatic.com.
const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILES = "https://fonts.gstatic.com";

const DIRECTIVES = {
  "default-src": ["'self'"],
  // 'wasm-unsafe-eval': WASM-Module (Kern, render2d/3d, truck). Kein 'unsafe-eval', kein Inline-Skript.
  "script-src": ["'self'", "'wasm-unsafe-eval'"],
  // Import-Worker (DXF/IFC/Mesh/Punktwolke) und pdf.js-Worker: Modul-URLs aus dem eigenen Bundle.
  "worker-src": ["'self'", "blob:"],
  // React setzt viele Inline-`style`-Attribute -> 'unsafe-inline' (nur Stile, keine Skripte).
  "style-src": ["'self'", "'unsafe-inline'", GOOGLE_FONTS_CSS],
  "font-src": ["'self'", "data:", GOOGLE_FONTS_FILES],
  "img-src": ["'self'", "data:", "blob:", ...https],
  "media-src": ["'self'", "blob:"],
  "connect-src": [
    "'self'",
    "ipc:",
    "http://ipc.localhost",
    "blob:",
    "data:",
    ...https,
    "http://localhost:*",
    "http://127.0.0.1:*",
    "ws://127.0.0.1:*", // KI-Brücke (net/aiBridge.ts)
  ],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'none'"],
};

/** Die Richtlinie als Header-/Meta-Text. */
function buildCsp() {
  return Object.entries(DIRECTIVES)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

module.exports = { buildCsp, NET_HOSTS };
