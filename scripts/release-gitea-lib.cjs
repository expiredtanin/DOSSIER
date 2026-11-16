// [30] Release auf Gitea (git.openbureau.ch/karim/dossier), reine Hilfsfunktionen ohne Netz (getestet in
// src/update/releaseGitea.test.ts). Das Skript scripts/release-gitea.mjs ruft sie auf.
//
// Aufbau auf Gitea (Entscheid Maintainer 16.11.: nur Gitea, ein Repo):
//   - je Version ein Release `v<version>` mit den Paketen (AppImage, DMG, app.tar.gz + .sig) und SHA256SUMS.txt;
//     Betas (Version mit „-“) als Vorabversion markiert, neu angelegte Releases als ENTWURF.
//   - ein festes Release `latest` mit `latest.json` (Tauri-Updater) und `versions.json` (Versionsverlauf in den
//     Einstellungen, src/update/versionHistory.ts). Nur `--publish` schreibt es neu.
const REPO = "karim/dossier";
const HOST = "https://git.openbureau.ch";

/** Release-Tag zur Version: "1.0.0-beta.1" → "v1.0.0-beta.1". */
function tagFor(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`keine semver-Version: ${version}`);
  return `v${version}`;
}

/** Vorabversion, wenn die Version einen Zusatz trägt (semver „-beta.1“). */
function isPrerelease(version) {
  return version.includes("-");
}

/** Download-Adresse eines Release-Anhangs. */
function assetUrl(tag, name) {
  return `${HOST}/${REPO}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

/**
 * Pakete im Ordner erkennen. `files`: Dateinamen. Liefert die Rollen, die die Manifeste brauchen.
 * Mac: `*.dmg` (Download im Versionsverlauf), `*.app.tar.gz` + `.sig` (Tauri-Updater). Linux: `*.AppImage`.
 */
function classifyAssets(files) {
  const pick = (re) => files.filter((f) => re.test(f)).sort();
  return {
    dmg: pick(/\.dmg$/i)[0] ?? null,
    updater: pick(/\.app\.tar\.gz$/i)[0] ?? null,
    updaterSig: pick(/\.app\.tar\.gz\.sig$/i)[0] ?? null,
    appImage: pick(/\.AppImage$/)[0] ?? null,
    all: files.filter((f) => /\.(dmg|AppImage|tar\.gz|sig|zip|deb|rpm)$/i.test(f)).sort(),
  };
}

/** SHA256SUMS.txt im Format von `sha256sum` (zwei Leerzeichen, sortiert). `sums`: {name: hex}. */
function sha256sums(sums) {
  return Object.keys(sums).sort().map((n) => `${sums[n]}  ${n}`).join("\n") + "\n";
}

/**
 * `latest.json` für den Tauri-Updater. Ohne Mac-Updater-Paket mit Signatur gibt es keinen Eintrag für
 * macOS — dann `null` (das alte Manifest bleibt stehen, die Mac-App bietet kein Linux-Paket an).
 */
function latestManifest({ version, notes, pubDate, tag, updater, signature, arch = "aarch64" }) {
  if (!updater || !signature) return null;
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: { [`darwin-${arch}`]: { signature: signature.trim(), url: assetUrl(tag, updater) } },
  };
}

/**
 * `versions.json`: neuer Eintrag vorne, gleiche Version ersetzt, höchstens `max` Einträge. Einträge ohne DMG
 * (reine Linux-Releases) erscheinen nicht: der Versionsverlauf bietet nur Mac-DMGs zum Download an.
 */
function mergeVersions(existing, entry, max = 30) {
  const rest = (Array.isArray(existing) ? existing : []).filter((e) => e && e.version !== entry.version);
  if (!entry.dmg) return rest.slice(0, max);
  return [entry, ...rest].slice(0, max);
}

/**
 * [268] Vorhandenen Release-Anhang lesen: Text, `null` nur wenn es ihn nicht gibt (404). Jeder andere Fehler (Netz, 5xx,
 * Proxy) wirft — sonst überschriebe `--publish` versions.json mit nur der neuen Version bzw. fielen die Prüfsummen der
 * anderen Plattform aus SHA256SUMS.txt.
 */
async function fetchExisting(fetchFn, url, headers) {
  const res = await fetchFn(url, headers ? { headers } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text().catch(() => "")}`.trim());
  return res.text();
}

/** SHA256SUMS.txt lesen: {name: hex}; Zeilen in anderem Format werden übergangen. */
function parseSums(txt) {
  const out = {};
  for (const line of String(txt).split("\n")) {
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/**
 * [268] Temporärer Name für das Hochladen eines Anhangs, der einen gleichnamigen ersetzt: erst hochladen, dann den alten
 * löschen und den neuen umbenennen — scheitert der Upload, bleibt der alte (z. B. `latest.json`) stehen.
 */
function tempAssetName(name, stamp) {
  return `${name}.upload-${stamp}`;
}

/** [268] Haben die Namen Mac-Pakete (DMG oder Updater-Archiv)? */
function hasMacPackages(names) {
  const a = classifyAssets(names);
  return !!(a.dmg || a.updater);
}

/**
 * [268] Vorprüfung vor dem Hochladen. `release`: vorhandenes Release (mit `draft`, `assets`) oder null; `localFiles`: Namen im
 * --dir. Liefert eine Fehlermeldung oder null.
 *  - ohne --publish auf ein schon VERÖFFENTLICHTES Release: Abbruch, ausser --replace-published;
 *  - --publish ohne Mac-Pakete (lokal oder schon am Release): Abbruch, ausser --linux-only (sonst bliebe latest.json alt,
 *    das Release erschiene ohne DMG).
 */
function preflight({ release, localFiles, publish, replacePublished, linuxOnly }) {
  if (release && release.draft === false && !publish && !replacePublished) {
    return `Release ${release.tag_name ?? ""} ist schon veröffentlicht; ohne --publish würden seine Pakete ersetzt. Mit --replace-published bewusst tun.`.replace("  ", " ");
  }
  if (publish && !linuxOnly) {
    const names = [...localFiles, ...((release && release.assets) || []).map((x) => x.name)];
    if (!hasMacPackages(names)) {
      return "--publish ohne Mac-Pakete (DMG, app.tar.gz): latest.json bliebe alt und das Release erschiene ohne DMG. Erst die Mac-Pakete hochladen, oder mit --linux-only bewusst nur Linux veröffentlichen.";
    }
  }
  return null;
}

module.exports = { REPO, HOST, tagFor, isPrerelease, assetUrl, classifyAssets, sha256sums, latestManifest, mergeVersions, fetchExisting, parseSums, tempAssetName, hasMacPackages, preflight };
