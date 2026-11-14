// Tests fuer saveTextFile. Vitest laeuft hier im "node"-Env (kein jsdom), daher
// stubben wir eine minimale DOM-/URL-Umgebung, um den Browser-Fallback-Pfad zu
// pruefen — ohne echten Tauri (kein `__TAURI_INTERNALS__`).

import { afterEach, describe, expect, it, vi } from "vitest";
import { saveTextFile } from "./saveFile";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Stubt Blob, URL und ein rudimentaeres document fuer den Anchor-Download. */
function stubBrowserEnv() {
  const clicked: string[] = [];
  const anchor: Record<string, unknown> = {
    click: () => clicked.push("click"),
  };
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:stub",
    revokeObjectURL: () => {},
  });
  vi.stubGlobal("document", {
    createElement: () => anchor,
    body: { appendChild: () => {}, removeChild: () => {} },
  });
  return { clicked, anchor };
}

describe("saveTextFile", () => {
  it("nimmt im Nicht-Tauri-Umfeld den Browser-Download und liefert true", async () => {
    // Kein __TAURI_INTERNALS__ → Browser-Pfad.
    const hadWindow = typeof globalThis.window !== "undefined";
    if (!hadWindow) vi.stubGlobal("window", {});
    const { clicked, anchor } = stubBrowserEnv();

    const ok = await saveTextFile("hallo", "modell.txt", "text/plain");

    expect(ok).toBe(true);
    expect(clicked).toContain("click");
    expect(anchor.download).toBe("modell.txt");
  });

  it("nutzt den Standard-MIME-Typ ohne Angabe, ohne zu crashen", async () => {
    const hadWindow = typeof globalThis.window !== "undefined";
    if (!hadWindow) vi.stubGlobal("window", {});
    stubBrowserEnv();

    await expect(saveTextFile("x", "a.bin")).resolves.toBe(true);
  });
});

describe("saveTextFile atomar ([116])", () => {
  async function withTauri(invoke: (cmd: string, args: unknown) => Promise<unknown>) {
    vi.resetModules();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/x/a.obp" }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    return import("./saveFile");
  }

  it("ruft save_atomic mit Pfad und Inhalt und meldet den Pfad erst danach", async () => {
    const calls: unknown[][] = [];
    const m = await withTauri(async (cmd, args) => void calls.push([cmd, args]));
    const saved: string[] = [];
    const ok = await m.saveTextFile("{}", "a.obp", "application/json", undefined, (p) => saved.push(p), true);
    expect(ok).toBe(true);
    expect(calls).toEqual([["save_atomic", { path: "/tmp/x/a.obp", content: "{}" }]]);
    expect(saved).toEqual(["/tmp/x/a.obp"]);
  });

  it("wirft SaveError bei Fehler, ohne Download-Fallback und ohne Pfad-Callback", async () => {
    const m = await withTauri(async () => {
      throw "Umbenennen: Permission denied";
    });
    const saved: string[] = [];
    await expect(
      m.saveTextFile("{}", "a.obp", "application/json", undefined, (p) => saved.push(p), true),
    ).rejects.toBeInstanceOf(m.SaveError);
    expect(saved).toEqual([]);
  });

  it("Fehler im Speichern-Dialog selbst: SaveError statt stillem Download (Projekt gilt als ungespeichert)", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.doMock("@tauri-apps/plugin-dialog", () => ({
      save: async () => {
        throw new Error("Dialog nicht verfügbar");
      },
    }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: async () => {} }));
    const m = await import("./saveFile");
    await expect(m.saveTextFile("{}", "a.obp", "application/json", undefined, undefined, true)).rejects.toBeInstanceOf(m.SaveError);
  });
});
