// [170] Linux-Paket (electron-builder): alles, was der Electron-Hauptprozess zur Laufzeit lädt, muss im Paket stehen.
// Befund 16.11.: `scripts/electron-files.cjs` ([116]) fehlte in `files` — das AppImage startete gar nicht
// („Cannot find module './electron-files.cjs'“). Dazu: Buildnummer ([261]) aus dem gebauten `dist` ins Paket.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test/tmpDir";

const root = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Einträge der Liste `files:` in electron-builder.yml (eine Zeile `  - muster` je Eintrag). */
function packagedFiles(): string[] {
  const lines = read("electron-builder.yml").split("\n");
  const start = lines.findIndex((l) => /^files:\s*$/.test(l));
  expect(start, "files: in electron-builder.yml").toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^\s+-\s+"?([^"#]+?)"?\s*(#.*)?$/.exec(l);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/** Relative `require("./…")` eines Skripts, rekursiv (nur scripts/*.cjs). */
function localRequires(rel: string, seen = new Set<string>()): Set<string> {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  for (const m of read(rel).matchAll(/require\(\s*["']\.\/([^"']+)["']\s*\)/g)) localRequires(`scripts/${m[1]}`, seen);
  return seen;
}

describe("[170] electron-builder: Paketinhalt", () => {
  it("jedes vom Hauptprozess und Preload geladene Skript ist im Paket", () => {
    const files = new Set(packagedFiles());
    const needed = new Set([...localRequires("scripts/electron-main.cjs"), ...localRequires("scripts/electron-preload.cjs")]);
    const missing = [...needed].filter((f) => !files.has(f));
    expect(missing).toEqual([]);
  });
  it("Preload-Pfad und Einstieg zeigen auf Dateien im Paket", () => {
    const files = new Set(packagedFiles());
    expect(read("scripts/electron-main.cjs")).toMatch(/preload: path\.join\(__dirname, "electron-preload\.cjs"\)/);
    expect(files.has("scripts/electron-preload.cjs")).toBe(true);
    expect(read("electron-builder.yml")).toMatch(/^\s+main: scripts\/electron-main\.cjs$/m);
    expect(files.has("dist/**")).toBe(true);
  });
});

const { packConfig, readDistBuild } = createRequire(import.meta.url)("../../scripts/electron-pack.cjs") as {
  packConfig: (build: string, version?: string) => { extends: string; buildVersion: unknown; extraMetadata: Record<string, unknown> };
  readDistBuild: (distDir: string) => { version: string; build: string } | null;
};

describe("[170][261] Buildnummer im Linux-Paket", () => {
  it("electron-builder bekommt die Buildnummer als Zeichenkette (buildVersion + Metadaten), erbt electron-builder.yml", () => {
    // Befund 16.11.: über `-c.extraMetadata.dossierBuild=261116.10` machte die Kommandozeile daraus die Zahl 261116.1.
    const c = packConfig("261116.10");
    expect(c.extends).toBe("./electron-builder.yml");
    expect(c.buildVersion).toBe("261116.10");
    expect(c.extraMetadata).toEqual({ dossierBuild: "261116.10" });
    // Release aus dem Tag: Version überschreibt die aus package.json.
    expect(packConfig("261116.3", "1.0.0").extraMetadata).toEqual({ dossierBuild: "261116.3", version: "1.0.0" });
  });
  it("Buildnummer kommt aus dem gebauten dist (build-info.json), nicht neu berechnet", () => {
    const dir = makeTmpDir("dossier-dist-");
    try {
      expect(readDistBuild(dir)).toBeNull();
      writeFileSync(join(dir, "build-info.json"), JSON.stringify({ version: "1.0.0-beta.1", build: "261116.2" }));
      expect(readDistBuild(dir)).toEqual({ version: "1.0.0-beta.1", build: "261116.2" });
      writeFileSync(join(dir, "build-info.json"), JSON.stringify({ version: "1.0.0-beta.1", build: "kaputt" }));
      expect(readDistBuild(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
