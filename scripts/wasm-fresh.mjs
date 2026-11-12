// Baut veraltete WASM-Pakete (`src/engine/pkg*`, gitignored) vor `tauri dev|build` neu: Ist eine Quelle
// eines Crates (oder eines per Pfad eingebundenen Crates) neuer als das gebaute `.wasm`, läuft das
// passende `npm run build:*`. Sonst passen TS-Oberfläche und Kern nicht zusammen (z. B. „Plan-Puffer
// unlesbar“ nach einem `git pull` mit Formatänderung). Aufruf: `node scripts/wasm-fresh.mjs` (auch aus
// `tauri-native.mjs`); Opt-out: DOSSIER_NO_WASM_CHECK=1.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Paket → gebaute Datei, npm-Skript und die Crates, aus denen es entsteht (inkl. Pfad-Abhängigkeiten). */
export const PACKAGES = [
  { wasm: "src/engine/pkgCore/core_bg.wasm", script: "build:core", crates: ["core", "kernel2d", "hatchgen", "render3d"] },
  { wasm: "src/engine/pkg/render2d_bg.wasm", script: "build:engine", crates: ["render2d"] },
  { wasm: "src/engine/pkg3d/render3d_bg.wasm", script: "build:engine3d", crates: ["render3d", "hatchgen"] },
  { wasm: "src/engine/pkgFileIo/fileio_bg.wasm", script: "build:fileio", crates: ["fileio", "hatchgen"] },
  { wasm: "src/engine/pkgTruck/trucksolid_bg.wasm", script: "build:truck", crates: ["trucksolid"] },
];

function newest(dir) {
  if (!existsSync(dir)) return 0;
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) t = Math.max(t, newest(p));
    else if (e.isFile()) t = Math.max(t, statSync(p).mtimeMs);
  }
  return t;
}

/** Pakete, deren `.wasm` fehlt oder älter ist als eine ihrer Quellen. */
export function stalePackages(base = root) {
  return PACKAGES.filter((p) => {
    const wasm = join(base, p.wasm);
    if (!existsSync(wasm)) return true;
    const built = statSync(wasm).mtimeMs;
    const src = Math.max(
      ...p.crates.flatMap((c) => [newest(join(base, "src-tauri", c, "src")), existsSync(join(base, "src-tauri", c, "Cargo.toml")) ? statSync(join(base, "src-tauri", c, "Cargo.toml")).mtimeMs : 0]),
    );
    return src > built;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && !process.env.DOSSIER_NO_WASM_CHECK) {
  for (const p of stalePackages()) {
    console.log(`[wasm-fresh] ${p.wasm} ist veraltet → npm run ${p.script}`);
    const r = spawnSync("npm", ["run", p.script], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}
