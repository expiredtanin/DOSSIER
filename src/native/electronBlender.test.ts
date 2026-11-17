// [273] Arbeitsordner der Blender-/Cycles-Brücke im Electron-Hauptprozess (scripts/electron-blender.cjs): Löschen eines
// einzelnen Auftragsordners und Aufräumen alter Ordner beim Start (nur eigenes Präfix, nur ältere als die Frist).
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { makeTmpDir } from "../test/tmpDir";

const bl = createRequire(import.meta.url)("../../scripts/electron-blender.cjs") as {
  prepareJobDir: (files: { path: string; bytes: Uint8Array }[]) => string;
  removeJobDir: (p: unknown) => void;
  sweepOldJobDirs: (root: string, maxAgeMs: number, now?: number) => number;
  insideRenderDir: (p: string) => boolean;
};

// prepareJobDir legt die Wurzel `<TMPDIR>/dossier-render` an; sie gehört dem Test.
afterAll(() => rmSync(join(tmpdir(), "dossier-render"), { recursive: true, force: true }));

const DAY = 24 * 3600 * 1000;

describe("removeJobDir", () => {
  it("löscht einen Arbeitsordner samt Inhalt, nie die Wurzel oder Fremdes", () => {
    const d = bl.prepareJobDir([{ path: "a/b.txt", bytes: new Uint8Array([1]) }]);
    expect(existsSync(join(d, "a", "b.txt"))).toBe(true);
    bl.removeJobDir(d);
    expect(existsSync(d)).toBe(false);
    bl.removeJobDir(d); // zweites Mal: kein Fehler
    for (const bad of [join(tmpdir(), "dossier-render"), tmpdir(), "/etc", "", 7, join(tmpdir(), "dossier-render", "..")]) expect(() => bl.removeJobDir(bad)).toThrow();
  });
});

describe("sweepOldJobDirs", () => {
  it("entfernt nur Ordner älter als die Frist, lässt neue und Fremdes stehen", () => {
    const root = makeTmpDir("dossier-sweep-");
    const now = Date.now();
    const old = join(root, "alt");
    const fresh = join(root, "neu");
    mkdirSync(old);
    mkdirSync(fresh);
    writeFileSync(join(old, "scene.json"), "{}");
    const past = new Date(now - 2 * DAY);
    utimesSync(old, past, past);
    expect(bl.sweepOldJobDirs(root, DAY, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
  it("fehlende Wurzel: 0, kein Fehler", () => {
    expect(bl.sweepOldJobDirs(join(makeTmpDir("dossier-sweep-"), "nix"), DAY)).toBe(0);
  });
});
