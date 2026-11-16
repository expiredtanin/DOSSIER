#!/usr/bin/env node
// [30] Pakete als Release auf git.openbureau.ch/karim/dossier (Gitea) ablegen.
//
//   node scripts/release-gitea.mjs [--dir release] [--version 1.0.0-beta.1] [--notes "…"] [--publish] [--dry-run]
//                                  [--replace-published] [--linux-only]
//
// Ohne --publish entsteht bzw. ergänzt das Skript einen ENTWURF `v<version>` (Vorabversion bei „-beta“) und lädt alle
// Pakete aus --dir hoch (AppImage, DMG, app.tar.gz + .sig), dazu SHA256SUMS.txt. Vorhandene Anhänge gleichen Namens
// werden ersetzt, damit Linux (Container/CI) und Mac (Rechner des Maintainers) nacheinander dasselbe Release füllen.
// Mit --publish wird der Entwurf veröffentlicht und, falls ein Mac-Updater-Paket mit Signatur dabei ist, das feste
// Release `latest` mit latest.json/versions.json nachgeführt (Tauri-Updater, Versionsverlauf).
// [268] Ersetzen lädt erst unter temporärem Namen hoch, löscht dann den alten Anhang und benennt um. Ohne --publish auf ein
// schon veröffentlichtes Release: Abbruch (--replace-published). --publish ohne Mac-Pakete: Abbruch (--linux-only).
//
// Zugang: Umgebungsvariable GITEA_TOKEN (Gitea → Einstellungen → Anwendungen → Token mit Repo-Schreibrecht).
// In der Cloud-Umgebung setzt ein Proxy den Zugang selbst; dort genügt GITEA_TOKEN=proxy-injected.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const lib = require("./release-gitea-lib.cjs");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const root = resolve(new URL("..", import.meta.url).pathname);
const version = opt("version", JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
const dir = resolve(opt("dir", join(root, "release")));
const notes = opt("notes", `Dossier ${version}`);
const publish = flag("publish");
const dryRun = flag("dry-run");
const replacePublished = flag("replace-published"); // [268] ein schon veröffentlichtes Release ohne --publish ersetzen
const linuxOnly = flag("linux-only"); // [268] --publish ohne Mac-Pakete bewusst erlauben
const tag = lib.tagFor(version);
const api = `${lib.HOST}/api/v1/repos/${lib.REPO}`;
const token = process.env.GITEA_TOKEN;
if (!token && !dryRun) {
  console.error("GITEA_TOKEN fehlt (Token mit Schreibrecht auf karim/dossier).");
  process.exit(2);
}
const headers = { Accept: "application/json", ...(token && token !== "proxy-injected" ? { Authorization: `token ${token}` } : {}) };

async function call(method, path, body, extra = {}) {
  if (dryRun && method !== "GET") {
    console.log(`[dry-run] ${method} ${path}`);
    return {};
  }
  const res = await fetch(path.startsWith("http") ? path : `${api}${path}`, { method, headers: { ...headers, ...extra }, body });
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : res.json();
}

async function uploadAsset(release, name, data) {
  const old = (release.assets ?? []).find((a) => a.name === name);
  // [268] Ersetzen: erst unter temporärem Namen hochladen, dann den alten löschen und umbenennen — scheitert der Upload,
  // bleibt der alte Anhang (z. B. latest.json) stehen.
  const upName = old ? lib.tempAssetName(name, Date.now()) : name;
  const form = new FormData();
  form.append("attachment", new Blob([data]), upName);
  const created = await call("POST", `/releases/${release.id}/assets?name=${encodeURIComponent(upName)}`, form);
  if (old) {
    await call("DELETE", `/releases/${release.id}/assets/${old.id}`);
    await call("PATCH", `/releases/${release.id}/assets/${created.id}`, JSON.stringify({ name }), { "Content-Type": "application/json" });
  }
  console.log(`  hochgeladen: ${name} (${(data.length / 1e6).toFixed(1)} MB)`);
}

async function findRelease(tagName) {
  const existing = await call("GET", `/releases/tags/${encodeURIComponent(tagName)}`);
  if (existing) return existing;
  // Entwürfe findet /releases/tags nicht: in der Liste suchen.
  const list = (await call("GET", `/releases?draft=true&limit=50`)) ?? [];
  return list.find((r) => r.tag_name === tagName) ?? null;
}

async function ensureRelease(tagName, { draft, prerelease, body, target }, found) {
  const existing = found === undefined ? await findRelease(tagName) : found;
  if (existing) return existing;
  return call("POST", "/releases", JSON.stringify({ tag_name: tagName, name: tagName, body, draft, prerelease, target_commitish: target }), {
    "Content-Type": "application/json",
  });
}

async function main() {
  const files = statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir) : [];
  const a = lib.classifyAssets(files);
  if (a.all.length === 0) throw new Error(`keine Pakete in ${dir} (erst npm run electron:pack bzw. npm run tauri:build)`);
  console.log(`Release ${tag} (${lib.isPrerelease(version) ? "Vorabversion" : "Version"}), Pakete aus ${dir}:`);

  // [268] Vorprüfung vor jeder Änderung (auch vor dem Anlegen des Entwurfs).
  const found = await findRelease(tag);
  const problem = lib.preflight({ release: found, localFiles: a.all, publish, replacePublished, linuxOnly });
  if (problem) throw new Error(problem);
  const rel = await ensureRelease(tag, { draft: true, prerelease: lib.isPrerelease(version), body: notes, target: "master" }, found);
  const sums = {};
  for (const name of a.all) {
    const data = readFileSync(join(dir, name));
    sums[name] = createHash("sha256").update(data).digest("hex");
    await uploadAsset(rel, name, data);
  }
  // Prüfsummen mit denen, die schon am Release hängen (andere Plattform), zusammenführen.
  const prevSums = (rel.assets ?? []).find((x) => x.name === "SHA256SUMS.txt");
  if (prevSums && !dryRun) {
    // [268] Nicht lesbar: abbrechen statt die Prüfsummen der anderen Plattform stillschweigend zu verlieren.
    const txt = await lib.fetchExisting(fetch, prevSums.browser_download_url, headers);
    if (txt === null) throw new Error(`SHA256SUMS.txt hängt am Release, liess sich aber nicht laden (${prevSums.browser_download_url})`);
    for (const [name, hex] of Object.entries(lib.parseSums(txt))) if (!(name in sums)) sums[name] = hex;
  }
  await uploadAsset(rel, "SHA256SUMS.txt", Buffer.from(lib.sha256sums(sums)));

  if (!publish) {
    console.log(`Entwurf bereit: ${lib.HOST}/${lib.REPO}/releases — veröffentlichen mit --publish oder in Gitea.`);
    return;
  }
  await call("PATCH", `/releases/${rel.id}`, JSON.stringify({ draft: false }), { "Content-Type": "application/json" });
  console.log(`veröffentlicht: ${tag}`);

  const pubDate = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const signature = a.updaterSig ? readFileSync(join(dir, a.updaterSig), "utf8") : null;
  const latest = lib.latestManifest({ version, notes, pubDate, tag, updater: a.updater, signature });
  if (!latest) {
    console.log("kein Mac-Updater-Paket mit Signatur: latest.json bleibt unverändert.");
    return;
  }
  const fixed = await ensureRelease("latest", { draft: false, prerelease: false, body: "Updater-Manifest (latest.json, versions.json).", target: "master" });
  // [268] Nur „gibt es noch nicht“ (404) zählt als leerer Verlauf; Netz-/Serverfehler brechen ab, statt ihn zu überschreiben.
  const versionsTxt = await lib.fetchExisting(fetch, lib.assetUrl("latest", "versions.json"));
  const oldVersions = versionsTxt === null ? [] : JSON.parse(versionsTxt);
  const versions = lib.mergeVersions(oldVersions, { version, tag, pub_date: pubDate, notes, dmg: a.dmg });
  await uploadAsset(fixed, "latest.json", Buffer.from(JSON.stringify(latest, null, 2) + "\n"));
  await uploadAsset(fixed, "versions.json", Buffer.from(JSON.stringify(versions, null, 2) + "\n"));
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
