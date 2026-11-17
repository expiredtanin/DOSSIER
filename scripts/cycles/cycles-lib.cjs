// [215] Cycles-Pakete: Namen, Release-Tag, Download-Adresse — reine Funktionen ohne Netz (getestet in
// src/native/cyclesPackage.test.ts). Benutzt von fetch.mjs (App-Bau lädt das fertige Paket) und upload-gitea.mjs (cycles.yml
// legt es ab). Das Paket wird in `.github/workflows/cycles.yml` gebaut und als Asset am Gitea-Release `cycles-<version>`
// (git.openbureau.ch/karim/dossier) abgelegt, damit die App-Builds Cycles nicht jedes Mal neu bauen.
const fs = require("node:fs");
const path = require("node:path");
const { HOST, REPO } = require("../release-gitea-lib.cjs");

const OSES = ["linux", "macos"];
const ARCHES = ["x86_64", "arm64"];

/** Cycles-Version aus `scripts/cycles/VERSION` (z. B. "5.3.0"). */
function cyclesVersion(dir = __dirname) {
  const v = fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`scripts/cycles/VERSION: keine Version: ${v}`);
  return v;
}

/** Release-Tag auf Gitea: "5.3.0" → "cycles-5.3.0". */
function releaseTag(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`keine Cycles-Version: ${version}`);
  return `cycles-${version}`;
}

/** Name des Pakets (Asset und Artefakt), wie `pack.sh` ihn schreibt. */
function assetName(os, arch, version) {
  if (!OSES.includes(os)) throw new Error(`unbekanntes Betriebssystem: ${os}`);
  if (!ARCHES.includes(arch)) throw new Error(`unbekannte Architektur: ${arch}`);
  releaseTag(version);
  return `cycles-${os}-${arch}-${version}.tar.xz`;
}

/** Name des Actions-Artefakts (ohne Endung), z. B. "cycles-linux-x86_64-5.3.0". */
function artifactName(os, arch, version) {
  return assetName(os, arch, version).replace(/\.tar\.xz$/, "");
}

/** Download-Adresse des Pakets am Gitea-Release. */
function downloadUrl(os, arch, version) {
  return `${HOST}/${REPO}/releases/download/${releaseTag(version)}/${encodeURIComponent(assetName(os, arch, version))}`;
}

/** Plattform des laufenden Rechners im Namensschema des Pakets. */
function hostPlatform(platform = process.platform, arch = process.arch) {
  const os = platform === "darwin" ? "macos" : platform === "linux" ? "linux" : null;
  const a = arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : null;
  if (!os || !a) throw new Error(`keine Cycles-Pakete für ${platform}/${arch}`);
  return { os, arch: a };
}

/** Erste Zeile `<sha256>  <name>` einer `.sha256`-Datei → Hex, sonst null. */
function parseSha256(txt) {
  const m = /^([0-9a-f]{64})\s/.exec(String(txt).trim());
  return m ? m[1] : null;
}

module.exports = { OSES, ARCHES, cyclesVersion, releaseTag, assetName, artifactName, downloadUrl, hostPlatform, parseSha256 };
