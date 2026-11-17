#!/usr/bin/env node
// [215] Cycles-Paket als Asset an das Gitea-Release `cycles-<version>` hängen (git.openbureau.ch/karim/dossier).
//
//   node scripts/cycles/upload-gitea.mjs --file cycles-linux-x86_64-5.3.0.tar.xz [--file …] [--dry-run]
//
// Das Release `cycles-<version>` ist ein Bau-Zwischenspeicher, kein Dossier-Release: veröffentlicht (sonst nicht ohne Token
// ladbar), als Vorabversion markiert. Gleichnamige Anhänge werden ersetzt (erst unter temporärem Namen hoch, dann alt löschen
// und umbenennen, wie release-gitea.mjs [268]); zu jedem Paket gehört `<name>.sha256` daneben. Zugang: GITEA_TOKEN (Schreibrecht).
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";

const require = createRequire(import.meta.url);
const lib = require("./cycles-lib.cjs");
const rel = require("../release-gitea-lib.cjs");

const args = process.argv.slice(2);
const files = args.flatMap((a, i) => (a === "--file" && args[i + 1] ? [args[i + 1]] : []));
const dryRun = args.includes("--dry-run");
const version = (() => {
  const i = args.indexOf("--version");
  return i >= 0 ? args[i + 1] : lib.cyclesVersion();
})();
if (!files.length) {
  console.error("upload-gitea: --file <paket.tar.xz> fehlt");
  process.exit(2);
}
const token = process.env.GITEA_TOKEN;
if (!token && !dryRun) {
  console.error("GITEA_TOKEN fehlt (Token mit Schreibrecht auf karim/dossier).");
  process.exit(2);
}
const tag = lib.releaseTag(version);
const api = `${rel.HOST}/api/v1/repos/${rel.REPO}`;
const headers = { Accept: "application/json", ...(token && token !== "proxy-injected" ? { Authorization: `token ${token}` } : {}) };

async function call(method, path, body, extra = {}) {
  if (dryRun && method !== "GET") {
    console.log(`[dry-run] ${method} ${path}`);
    return { id: 0, assets: [] };
  }
  const res = await fetch(path.startsWith("http") ? path : `${api}${path}`, { method, headers: { ...headers, ...extra }, body });
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

async function upload(release, name, data) {
  const old = (release.assets ?? []).find((a) => a.name === name);
  const upName = old ? rel.tempAssetName(name, Date.now()) : name;
  const form = new FormData();
  form.append("attachment", new Blob([data]), upName);
  const created = await call("POST", `/releases/${release.id}/assets?name=${encodeURIComponent(upName)}`, form);
  if (old) {
    await call("DELETE", `/releases/${release.id}/assets/${old.id}`);
    await call("PATCH", `/releases/${release.id}/assets/${created.id}`, JSON.stringify({ name }), { "Content-Type": "application/json" });
  }
  console.log(`  hochgeladen: ${name} (${(data.length / 1e6).toFixed(1)} MB)`);
}

let release = await call("GET", `/releases/tags/${encodeURIComponent(tag)}`);
if (!release) {
  release = await call(
    "POST",
    "/releases",
    JSON.stringify({
      tag_name: tag,
      name: `Cycles ${version} (Bau-Paket)`,
      body: `Cycles ${version} als Hilfsprogramm für die Dossier-App ([215]); gebaut von .github/workflows/cycles.yml. Kein App-Release.`,
      draft: false,
      prerelease: true,
      target_commitish: "master",
    }),
    { "Content-Type": "application/json" },
  );
}
for (const f of files) {
  if (!existsSync(f)) throw new Error(`Datei fehlt: ${f}`);
  const name = basename(f);
  if (!/^cycles-(linux|macos)-(x86_64|arm64)-\d+\.\d+\.\d+\.tar\.xz$/.test(name)) throw new Error(`kein Cycles-Paketname: ${name}`);
  await upload(release, name, readFileSync(f));
  if (existsSync(`${f}.sha256`)) await upload(release, `${name}.sha256`, readFileSync(`${f}.sha256`));
}
console.log(`Release ${tag}: ${rel.HOST}/${rel.REPO}/releases/tag/${tag}`);
