// Atomares Schreiben im Electron-Hauptprozess ([116], scripts/electron-files.cjs) — gleiche Garantien wie atomic_save.rs.

import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const { writeAtomic, backupExists } = createRequire(import.meta.url)("../../scripts/electron-files.cjs") as {
  writeAtomic: (file: string, text: string, keepBackup: boolean) => void;
  backupExists: (file: string) => boolean;
};

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "dossier-efiles-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("electron-files: atomares Speichern", () => {
  it("neue Datei ohne Sicherung, keine Temp-Datei", () => {
    const p = join(tmp(), "a.obp");
    writeAtomic(p, "eins", true);
    expect(readFileSync(p, "utf8")).toBe("eins");
    expect(backupExists(p)).toBe(false);
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });

  it("Überschreiben sichert die Vorversion als ~", () => {
    const p = join(tmp(), "a.obp");
    writeAtomic(p, "eins", true);
    writeAtomic(p, "zwei äöü", true);
    expect(readFileSync(p, "utf8")).toBe("zwei äöü");
    expect(readFileSync(`${p}~`, "utf8")).toBe("eins");
    expect(backupExists(p)).toBe(true);
  });

  it("Fehler lässt das Original heil und räumt die Temp-Datei auf", () => {
    const d = tmp();
    const p = join(d, "a.obp");
    writeAtomic(p, "original", true);
    mkdirSync(`${p}.tmp`); // Ordner an der Stelle der Temp-Datei
    expect(() => writeAtomic(p, "neu", true)).toThrow();
    expect(readFileSync(p, "utf8")).toBe("original");
    expect(() => writeAtomic(join(d, "nope", "b.obp"), "x", true)).toThrow();
  });

  it("liegengebliebene Temp-Datei eines Absturzes stört nicht", () => {
    const p = join(tmp(), "a.obp");
    writeAtomic(p, "alt", true);
    writeFileSync(`${p}.tmp`, '{"walls": [');
    writeAtomic(p, "neu", true);
    expect(readFileSync(p, "utf8")).toBe("neu");
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });
});
