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
