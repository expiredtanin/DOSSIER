// [261] Buildnummer nach Datum: `JJMMTT.N` (z. B. 261115.1). Eine Quelle für Vite (`define`), CLI-Build,
// Tauri-Build (`bundle.macOS.bundleVersion`) und Electron.
//   1. Umgebungsvariable DOSSIER_BUILD (z. B. CI) gewinnt, wenn sie wie JJMMTT.N aussieht.
//   2. Sonst heutiges Datum (lokal) + N = Anzahl Commits seit Mitternacht im Git-Log (`git log --since=midnight`).
//      Der Zähler wächst damit mit jedem Commit des Tages; zwei Builds ohne Commit dazwischen tragen dieselbe Nummer.
//   3. Ohne Git (Tarball) oder bei Fehler: `JJMMTT.0`.
const { execFileSync } = require("node:child_process");

const BUILD_RE = /^\d{6}\.\d+$/;

/** `JJMMTT` aus einem Datum (lokale Zeit). */
function dateStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Anzahl Commits seit Mitternacht, oder 0 ohne Git. */
function commitsToday(cwd) {
  try {
    const out = execFileSync("git", ["log", "--since=midnight", "--format=%H"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * @param {{ env?: Record<string, string|undefined>, now?: Date, commitCount?: number, cwd?: string }} [opts]
 * @returns {string} Buildnummer `JJMMTT.N`
 */
function computeBuildNumber(opts = {}) {
  const env = opts.env ?? process.env;
  const override = (env.DOSSIER_BUILD ?? "").trim();
  if (BUILD_RE.test(override)) return override;
  const now = opts.now ?? new Date();
  const n = opts.commitCount ?? commitsToday(opts.cwd);
  return `${dateStamp(now)}.${Math.max(0, Math.floor(n))}`;
}

module.exports = { computeBuildNumber, dateStamp, BUILD_RE };
