#!/usr/bin/env node
// electron-pack.cjs — Linux-Paket (AppImage x86_64) mit electron-builder bauen ([170]); `npm run electron:pack` nach `npm run build`.
// Buildnummer ([261]): kommt aus dem GEBAUTEN dist (`dist/build-info.json`, geschrieben vom Vite-Plugin in vite.config.ts),
// damit Oberfläche und Paket dieselbe Nummer tragen, auch wenn zwischen `build` und `pack` ein Commit liegt. electron-builder
// bekommt sie als `buildVersion` (unter Linux nur Metadaten) und `extraMetadata.dossierBuild` (package.json im Paket).
// Über die JS-Schnittstelle, nicht `-c.…` auf der Kommandozeile: dort würde „261116.10“ zur Zahl 261116.1.
// Optional `--version=1.2.3` (Release aus einem Tag) überschreibt die Version aus package.json.
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

/** Konfiguration für electron-builder: erbt `electron-builder.yml`, ergänzt Buildnummer (als Zeichenkette) und ggf. Version. */
function packConfig(build, version) {
  const extraMetadata = { dossierBuild: String(build) };
  if (version) extraMetadata.version = String(version);
  return { extends: "./electron-builder.yml", buildVersion: String(build), extraMetadata };
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
  console.log(`electron-pack: Dossier ${version ?? info.version} (Build ${info.build})`);
  const { build, Platform, Arch } = require("electron-builder");
  await build({
    projectDir: root,
    targets: Platform.LINUX.createTarget("AppImage", Arch.x64),
    publish: "never",
    config: packConfig(info.build, version),
  });
}

if (require.main === module)
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });

module.exports = { packConfig, readDistBuild };
