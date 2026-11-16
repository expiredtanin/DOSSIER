#!/usr/bin/env node
// electron-pack.cjs — Linux-Paket (AppImage x86_64) mit electron-builder bauen ([170]); `npm run electron:pack` nach `npm run build`.
// Buildnummer ([261]): kommt aus dem GEBAUTEN dist (`dist/build-info.json`, geschrieben vom Vite-Plugin in vite.config.ts),
// damit Oberfläche und Paket dieselbe Nummer tragen, auch wenn zwischen `build` und `pack` ein Commit liegt. electron-builder
// bekommt sie als `buildVersion` (unter Linux nur Metadaten) und `extraMetadata.dossierBuild` (package.json im Paket).
// Über die JS-Schnittstelle, nicht `-c.…` auf der Kommandozeile: dort würde „261116.10“ zur Zahl 261116.1.
// Optional `--version=1.2.3` (Release aus einem Tag) überschreibt die Version aus package.json.
// Cycles ([215]): liegt ein Paketordner mit dem Programm `cycles` bereit, kommt er als `extraResources` (Ordner `cycles/`) ins
// AppImage. Reihenfolge: `--cycles=ORDNER`, Umgebungsvariable DOSSIER_CYCLES_DIR (lokaler Ordner statt CI-Download, z. B. ein
// frisch gebautes `dist/` von scripts/cycles/build-linux.sh), sonst `build/cycles` (scripts/cycles/get.sh). Ohne: Paket ohne Cycles
// (Warnung); mit DOSSIER_REQUIRE_CYCLES=1 (Release-CI) ist das ein Fehler.
const fs = require("node:fs");
const path = require("node:path");
const { BUILD_RE } = require("./build-number.cjs");

/** Liest `{version, build}` aus `<distDir>/build-info.json`; `null`, wenn sie fehlt oder ungültig ist. */
function readDistBuild(distDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(distDir, "build-info.json"), "utf8"));
    if (typeof info?.version !== "string" || typeof info?.build !== "string" || !BUILD_RE.test(info.build)) return null;
    return { version: info.version, build: info.build };
  } catch {
    return null;
  }
}

/** Konfiguration für electron-builder: erbt `electron-builder.yml`, ergänzt Buildnummer (als Zeichenkette), ggf. Version und Cycles. */
function packConfig(build, version, cyclesDir) {
  const extraMetadata = { dossierBuild: String(build) };
  if (version) extraMetadata.version = String(version);
  const config = { extends: "./electron-builder.yml", buildVersion: String(build), extraMetadata };
  if (cyclesDir) config.extraResources = [{ from: cyclesDir, to: "cycles" }];
  return config;
}

/**
 * Cycles-Paketordner fürs AppImage ([215]) oder `null`. Wirft, wenn ein ausdrücklich genannter Ordner kein Programm `cycles` enthält
 * oder `DOSSIER_REQUIRE_CYCLES=1` gesetzt ist und nichts da ist.
 */
function resolveCyclesDir(root, argv, env) {
  const arg = argv.find((a) => a.startsWith("--cycles="));
  const explicit = arg ? arg.slice("--cycles=".length) : env.DOSSIER_CYCLES_DIR || "";
  const dir = explicit ? path.resolve(explicit) : path.join(root, "build", "cycles");
  const ok = fs.existsSync(path.join(dir, "cycles"));
  if (ok) return dir;
  if (explicit) throw new Error(`Cycles-Ordner ${dir} enthält kein Programm "cycles"`);
  if (env.DOSSIER_REQUIRE_CYCLES === "1") throw new Error("Cycles fehlt (build/cycles): zuerst scripts/cycles/get.sh linux x86_64");
  return null;
}

async function main() {
  const root = path.join(__dirname, "..");
  const info = readDistBuild(path.join(root, "dist"));
  if (!info) {
    console.error("electron-pack: dist/build-info.json fehlt oder ist ungültig — zuerst `npm run build`.");
    process.exit(1);
  }
  const versionArg = process.argv.slice(2).find((a) => a.startsWith("--version="));
  const version = versionArg ? versionArg.slice("--version=".length) : undefined;
  const cyclesDir = resolveCyclesDir(root, process.argv.slice(2), process.env);
  console.log(`electron-pack: Dossier ${version ?? info.version} (Build ${info.build}), Cycles: ${cyclesDir ?? "nicht enthalten (build/cycles fehlt)"}`);
  const { build, Platform, Arch } = require("electron-builder");
  await build({
    projectDir: root,
    targets: Platform.LINUX.createTarget("AppImage", Arch.x64),
    publish: "never",
    config: packConfig(info.build, version, cyclesDir),
  });
}

if (require.main === module)
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });

module.exports = { packConfig, readDistBuild, resolveCyclesDir };
