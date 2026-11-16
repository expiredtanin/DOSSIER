#!/usr/bin/env node
// test-linux-app.mjs — prüft das gebaute Linux-Paket ([170]): `npm run build && npm run electron:pack`, dann `npm run test:linux-app`.
// Paket: DOSSIER_ELECTRON_BIN, sonst das neueste `release/*.AppImage`, sonst `release/linux-unpacked/dossier`.
// Ohne Bildschirm (kein DISPLAY/WAYLAND_DISPLAY) läuft der Test unter `xvfb-run -a`. Ohne FUSE startet der Test das
// AppImage mit APPIMAGE_EXTRACT_AND_RUN=1 (e2e/linuxApp170.spec.ts). Weitere Argumente gehen an `playwright test`.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");

function findBin() {
  if (process.env.DOSSIER_ELECTRON_BIN) return resolve(process.env.DOSSIER_ELECTRON_BIN);
  const rel = join(root, "release");
  if (!existsSync(rel)) return null;
  const images = readdirSync(rel)
    .filter((f) => f.endsWith(".AppImage"))
    .map((f) => join(rel, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (images.length) return images[0];
  const unpacked = join(rel, "linux-unpacked", "dossier");
  return existsSync(unpacked) ? unpacked : null;
}

const bin = findBin();
if (!bin || !existsSync(bin)) {
  console.error("test-linux-app: kein Paket gefunden — zuerst `npm run build && npm run electron:pack` (oder DOSSIER_ELECTRON_BIN setzen).");
  process.exit(1);
}
console.log(`test-linux-app: prüfe ${bin}`);
const pw = [join(root, "node_modules", ".bin", "playwright"), "test", "-c", "playwright.electron.config.ts", ...process.argv.slice(2)];
const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const [cmd, ...args] = headless ? ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", ...pw] : pw;
const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, DOSSIER_ELECTRON_BIN: bin } });
if (r.error) console.error(`test-linux-app: ${r.error.message}${headless ? " (xvfb-run installiert?)" : ""}`);
process.exit(r.status ?? 1);
