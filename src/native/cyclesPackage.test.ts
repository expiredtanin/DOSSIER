// [215] Cycles-Paket: Namensschema (Bau, Gitea-Release, App-Bau), Einbindung ins AppImage (extraResources) und in die Workflows.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);
const root = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const lib = req("../../scripts/cycles/cycles-lib.cjs") as {
  cyclesVersion: () => string;
  releaseTag: (v: string) => string;
  assetName: (os: string, arch: string, v: string) => string;
  artifactName: (os: string, arch: string, v: string) => string;
  downloadUrl: (os: string, arch: string, v: string) => string;
  hostPlatform: (p?: string, a?: string) => { os: string; arch: string };
  parseSha256: (t: string) => string | null;
};
const pack = req("../../scripts/electron-pack.cjs") as {
  packConfig: (b: string, v?: string, c?: string) => { extraResources?: unknown };
  resolveCyclesDir: (root: string, argv: string[], env: Record<string, string>) => string | null;
};

describe("Cycles-Paketnamen", () => {
  it("Version aus scripts/cycles/VERSION, Tag, Asset, Artefakt, Adresse", () => {
    const v = lib.cyclesVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lib.releaseTag("5.3.0")).toBe("cycles-5.3.0");
    expect(lib.assetName("linux", "x86_64", "5.3.0")).toBe("cycles-linux-x86_64-5.3.0.tar.xz");
    expect(lib.artifactName("macos", "arm64", "5.3.0")).toBe("cycles-macos-arm64-5.3.0");
    expect(lib.downloadUrl("macos", "arm64", "5.3.0")).toBe("https://git.openbureau.ch/karim/dossier/releases/download/cycles-5.3.0/cycles-macos-arm64-5.3.0.tar.xz");
    expect(() => lib.assetName("windows", "x86_64", "5.3.0")).toThrow();
    expect(() => lib.releaseTag("v5.3")).toThrow();
  });
  it("Rechner → Paketname; Prüfsummendatei", () => {
    expect(lib.hostPlatform("linux", "x64")).toEqual({ os: "linux", arch: "x86_64" });
    expect(lib.hostPlatform("darwin", "arm64")).toEqual({ os: "macos", arch: "arm64" });
    expect(() => lib.hostPlatform("win32", "x64")).toThrow();
    expect(lib.parseSha256(`${"ab".repeat(32)}  cycles-linux-x86_64-5.3.0.tar.xz\n`)).toBe("ab".repeat(32));
    expect(lib.parseSha256("kaputt")).toBeNull();
  });
  it("pack.sh schreibt denselben Namen wie das Skript-Schema", () => {
    const sh = read("scripts/cycles/pack.sh");
    expect(sh).toContain('NAME="cycles-$OS-$ARCH-$VERSION.tar.xz"');
  });
});

describe("AppImage: Cycles als extraResources", () => {
  it("packConfig trägt den Ordner als `cycles/` ein, ohne Ordner nichts", () => {
    expect(pack.packConfig("1", undefined, "/x/cyc").extraResources).toEqual([{ from: "/x/cyc", to: "cycles" }]);
    expect(pack.packConfig("1").extraResources).toBeUndefined();
  });
  it("Ordnerwahl: --cycles, Umgebung, build/cycles; fehlendes Programm / Pflicht", () => {
    const d = mkdtempSync(join(tmpdir(), "dossier-cypack-"));
    try {
      expect(pack.resolveCyclesDir(d, [], {})).toBeNull();
      expect(() => pack.resolveCyclesDir(d, [], { DOSSIER_REQUIRE_CYCLES: "1" })).toThrow(/Cycles fehlt/);
      expect(() => pack.resolveCyclesDir(d, [`--cycles=${d}/nix`], {})).toThrow(/kein Programm/);
      mkdirSync(join(d, "build", "cycles"), { recursive: true });
      writeFileSync(join(d, "build", "cycles", "cycles"), "x");
      expect(pack.resolveCyclesDir(d, [], {})).toBe(join(d, "build", "cycles"));
      expect(pack.resolveCyclesDir(d, [`--cycles=${join(d, "build", "cycles")}`], {})).toBe(join(d, "build", "cycles"));
      expect(pack.resolveCyclesDir(d, [], { DOSSIER_CYCLES_DIR: join(d, "build", "cycles") })).toBe(join(d, "build", "cycles"));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("Hauptprozess und Preload verweisen auf electron-cycles, das Skript steht in `files`", () => {
    expect(read("scripts/electron-main.cjs")).toMatch(/electron-cycles\.cjs"\)\.register\(ipcMain, app\)/);
    expect(read("scripts/electron-preload.cjs")).toContain('exposeInMainWorld("dossierCycles"');
    expect(read("electron-builder.yml")).toMatch(/^\s+- scripts\/electron-cycles\.cjs$/m);
  });
});

describe("Workflows", () => {
  it("cycles.yml: Jobs linux (ubuntu-24.04) und macos (macos-latest, arm64), Artefakte, Gitea-Ablage", () => {
    const y = read(".github/workflows/cycles.yml");
    expect(y).toMatch(/^\s+linux:\n\s+runs-on: ubuntu-24\.04/m);
    expect(y).toMatch(/^\s+macos:\n\s+runs-on: macos-latest/m);
    expect(y).toContain("scripts/cycles/build-linux.sh");
    expect(y).toContain("scripts/cycles/build-macos.sh");
    expect(y).toContain("cycles-linux-x86_64-${{ steps.v.outputs.version }}");
    expect(y).toContain("cycles-macos-arm64-${{ steps.v.outputs.version }}");
    expect(y).toContain("scripts/cycles/upload-gitea.mjs");
    expect(y).toContain("workflow_dispatch");
    expect(y).toMatch(/paths:\n\s+- "scripts\/cycles\/\*\*"/);
  });
  it("release.yml lädt Cycles vor dem App-Bau (beide Jobs) und verlangt es für das AppImage", () => {
    const y = read(".github/workflows/release.yml");
    expect(y).toContain("scripts/cycles/get.sh macos arm64");
    expect(y).toContain("scripts/cycles/get.sh linux x86_64");
    expect(y.indexOf("get.sh macos arm64")).toBeLessThan(y.indexOf("tauri-apps/tauri-action"));
    expect(y.indexOf("get.sh linux x86_64")).toBeLessThan(y.indexOf("npm run electron:pack"));
    expect(y).toContain('DOSSIER_REQUIRE_CYCLES: "1"');
  });
  it("Tauri-Overlay: Sidecar + Ressourcen für Bibliotheken, Kernel-Quellen, Lizenzen", () => {
    const c = JSON.parse(read("src-tauri/tauri.cycles.conf.json")) as { bundle: { externalBin: string[]; resources: Record<string, string> } };
    expect(c.bundle.externalBin).toEqual(["binaries/cycles"]);
    expect(Object.values(c.bundle.resources).sort()).toEqual(["cycles/lib/", "cycles/licenses/", "cycles/source/"]);
  });
});
