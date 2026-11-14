// Sicherung der Vorversion (`<pfad>~`, [116]): erkennen/lesen unter Tauri und Electron; Electron speichert atomar über den Hauptprozess.

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

async function withTauri(invoke: Invoke) {
  vi.resetModules();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  vi.doMock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/a.obp" }));
  return import("./projectFile");
}

describe("Sicherung unter Tauri", () => {
  it("backupAvailable / readBackupText fragen die Rust-Befehle", async () => {
    const calls: [string, unknown][] = [];
    const m = await withTauri(async (cmd, args) => {
      calls.push([cmd, args]);
      return cmd === "backup_exists" ? true : "{\"alt\":1}";
    });
    expect(await m.backupAvailable("/tmp/a.obp")).toBe(true);
    expect(await m.readBackupText("/tmp/a.obp")).toBe("{\"alt\":1}");
    expect(calls.map((c) => c[0])).toEqual(["backup_exists", "read_backup"]);
  });

  it("Fehler der Befehle: keine Sicherung statt Absturz", async () => {
    const m = await withTauri(async () => {
      throw "kaputt";
    });
    expect(await m.backupAvailable("/tmp/a.obp")).toBe(false);
    expect(await m.readBackupText("/tmp/a.obp")).toBeNull();
  });
});

describe("Ohne Dateisystem (Browser)", () => {
  it("keine Sicherung", async () => {
    vi.stubGlobal("window", {});
    const m = await import("./projectFile");
    expect(await m.backupAvailable("/x.obp")).toBe(false);
    expect(await m.readBackupText("/x.obp")).toBeNull();
  });
});

describe("Electron: Projekt-Speichern über den Hauptprozess", () => {
  function withElectron(files: Record<string, unknown>) {
    vi.resetModules();
    vi.stubGlobal("window", { dossierFiles: files });
    return import("./projectFile");
  }

  it("bekannter Pfad: saveAtomic ohne Dialog, Pfad-Callback danach", async () => {
    const calls: unknown[][] = [];
    const m = await withElectron({ saveAtomic: async (...a: unknown[]) => void calls.push(a) });
    const saved: string[] = [];
    expect(await m.saveProjectFile("{}", "x", (p) => saved.push(p), "/home/u/a.obp")).toBe(true);
    expect(calls).toEqual([["/home/u/a.obp", "{}"]]);
    expect(saved).toEqual(["/home/u/a.obp"]);
  });

  it("ohne Pfad: Speichern-Dialog im Hauptprozess; Abbruch = false", async () => {
    const m = await withElectron({ saveAs: async () => null });
    expect(await m.saveProjectFile("{}", "x")).toBe(false);
    const m2 = await withElectron({ saveAs: async (name: string) => `/home/u/${name}` });
    const saved: string[] = [];
    expect(await m2.saveProjectFile("{}", "haus", (p) => saved.push(p))).toBe(true);
    expect(saved).toEqual(["/home/u/haus.obp"]);
  });

  it("Fehler: SaveError, kein Download", async () => {
    const m = await withElectron({
      saveAtomic: async () => {
        throw new Error("EACCES");
      },
    });
    const { SaveError } = await import("./saveFile");
    await expect(m.saveProjectFile("{}", "x", undefined, "/ro/a.obp")).rejects.toBeInstanceOf(SaveError);
  });

  it("backupAvailable / readBackupText über die Brücke", async () => {
    const m = await withElectron({ backupExists: async () => true, readBackup: async () => "text" });
    expect(await m.backupAvailable("/a.obp")).toBe(true);
    expect(await m.readBackupText("/a.obp")).toBe("text");
  });
});
