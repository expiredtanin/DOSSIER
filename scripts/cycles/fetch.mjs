#!/usr/bin/env node
// [215] Fertiges Cycles-Paket laden und auspacken (für den App-Bau in release.yml und für Entwickler):
//
//   node scripts/cycles/fetch.mjs [--os linux|macos] [--arch x86_64|arm64] [--out build/cycles] [--version 5.3.0]
//
// Quelle: Asset `cycles-<os>-<arch>-<version>.tar.xz` am Gitea-Release `cycles-<version>` (git.openbureau.ch/karim/dossier),
// mit Prüfsumme aus `<asset>.sha256`, falls vorhanden. GITEA_TOKEN ist nur nötig, wenn das Repository nicht öffentlich lesbar ist.
// Ausgang: 0 = ausgepackt nach --out (Ordner enthält `cycles`, `lib/`, `licenses/`); 3 = Paket gibt es dort nicht (404) — der
// Workflow weicht dann auf das Artefakt von cycles.yml aus; 1 = anderer Fehler.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const lib = createRequire(import.meta.url)("./cycles-lib.cjs");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const host = lib.hostPlatform();
const os = opt("os", host.os);
const arch = opt("arch", host.arch);
const version = opt("version", lib.cyclesVersion());
const out = resolve(opt("out", join(import.meta.dirname, "..", "..", "build", "cycles")));
const token = process.env.GITEA_TOKEN;
const headers = token && token !== "proxy-injected" ? { Authorization: `token ${token}` } : {};

const url = lib.downloadUrl(os, arch, version);
console.log(`cycles: lade ${url}`);
const res = await fetch(url, { headers });
if (res.status === 404) {
  console.error(`cycles: Paket nicht am Release ${lib.releaseTag(version)} (404) — erst cycles.yml laufen lassen oder dessen Artefakt nehmen.`);
  process.exit(3);
}
if (!res.ok) {
  console.error(`cycles: ${res.status} ${await res.text().catch(() => "")}`);
  process.exit(1);
}
const data = Buffer.from(await res.arrayBuffer());
const sumRes = await fetch(`${url}.sha256`, { headers });
if (sumRes.ok) {
  const want = lib.parseSha256(await sumRes.text());
  const got = createHash("sha256").update(data).digest("hex");
  if (want && want !== got) {
    console.error(`cycles: Prüfsumme stimmt nicht (${got} statt ${want})`);
    process.exit(1);
  }
  console.log(`cycles: Prüfsumme ok (${got.slice(0, 12)}…)`);
} else {
  console.log("cycles: keine .sha256 am Release — ohne Prüfsumme weiter");
}

const tmp = mkdtempSync(join(tmpdir(), "dossier-cycles-"));
try {
  const tarball = join(tmp, "cycles.tar.xz");
  writeFileSync(tarball, data);
  const t = spawnSync("tar", ["-xJf", tarball, "-C", tmp], { stdio: "inherit" });
  if (t.status !== 0) throw new Error("tar -xJf fehlgeschlagen (xz installiert?)");
  const inner = join(tmp, "cycles");
  if (!existsSync(join(inner, "cycles"))) throw new Error(`Paket hat nicht den erwarteten Aufbau (cycles/cycles fehlt): ${readdirSync(tmp).join(", ")}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(resolve(out, ".."), { recursive: true });
  renameSync(inner, out);
  console.log(`cycles: ausgepackt nach ${out}`);
} catch (e) {
  console.error(`cycles: ${e.message}`);
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
