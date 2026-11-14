// Exporte unter Tauri atomar schreiben ([116]): Rust-Befehl `save_export`, Fehler werden gemeldet, nie stiller Download.

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;

async function withTauri(invoke: Invoke) {
  vi.resetModules();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.doMock("@tauri-apps/plugin-dialog", () => ({ save: async () => "/tmp/Pläne/a b.pdf" }));
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
  return import("./saveFile");
}

describe("Exporte schreiben atomar ([116])", () => {
  it("saveBinaryFile: Bytes als Rohkörper, Pfad prozent-kodiert im Header", async () => {
    const calls: unknown[][] = [];
    const m = await withTauri(async (cmd, args, opts) => void calls.push([cmd, args, opts]));
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await m.saveBinaryFile(bytes, "a.pdf")).toBe(true);
    expect(calls).toEqual([["save_export", bytes, { headers: { "x-path": "%2Ftmp%2FPl%C3%A4ne%2Fa%20b.pdf" } }]]);
  });

  it("saveTextFile (kein Projekt): Text als UTF-8-Bytes über save_export", async () => {
    const calls: [string, Uint8Array][] = [];
    const m = await withTauri(async (cmd, args) => void calls.push([cmd, args as Uint8Array]));
    expect(await m.saveTextFile("äö", "a.dxf")).toBe(true);
    expect(calls[0][0]).toBe("save_export");
    expect(new TextDecoder().decode(calls[0][1])).toBe("äö");
  });

  it("Schreibfehler: gemeldet, false, kein Download-Fallback", async () => {
    const m = await withTauri(async () => {
      throw "Umbenennen: Permission denied";
    });
    const reported: string[] = [];
    m.setExportErrorReporter((msg) => reported.push(msg));
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL });
    expect(await m.saveBinaryFile(new Uint8Array([1]), "a.pdf")).toBe(false);
    expect(reported).toEqual(["Umbenennen: Permission denied"]);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("OBJ + MTL: beide Dateien atomar", async () => {
    const calls: string[] = [];
    const m = await withTauri(async (cmd) => void calls.push(cmd));
    const ok = await m.saveTextWithCompanion((n) => ({ main: `mtllib ${n}`, companion: "m" }), "a.obj", "mtl");
    expect(ok).toBe(true);
    expect(calls).toEqual(["save_export", "save_export"]);
  });
});
