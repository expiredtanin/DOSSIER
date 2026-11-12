import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { TEXT_FONTS } from "./fontList";
import { fontFileUrl, loadFontFile } from "./glyphFonts";

describe("glyphFonts", () => {
  it("jeder Schlüssel zeigt auf eine vorhandene Datei (ausser fehlenden Schnitten)", () => {
    const missing: string[] = [];
    for (let id = 2; id <= TEXT_FONTS.length; id++) {
      for (let style = 0; style < 4; style++) {
        const url = fontFileUrl((id << 8) | style)!;
        expect(url).toMatch(/^\/fonts\/[a-z0-9-]+\/[a-z0-9-]+-(400|700)-(normal|italic)\.woff2$/);
        if (!existsSync(`public${url}`)) missing.push(url);
      }
    }
    // Nur die Kursiv-Schnitte der Familien ohne Kursivdatei fehlen (Manrope, Outfit, Space Grotesk).
    expect(missing.every((u) => /manrope|outfit|space-grotesk/.test(u) && u.includes("italic"))).toBe(true);
    expect(fontFileUrl(0)).toBeNull();
    expect(fontFileUrl(1 << 8)).toBeNull();
    expect(fontFileUrl(99 << 8)).toBeNull();
  });

  it("lädt je Schlüssel einmal; 404 und Netzfehler ergeben null", async () => {
    let calls = 0;
    const ok = (async () => {
      calls++;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const key = (15 << 8) | 1;
    expect(Array.from((await loadFontFile(key, ok))!)).toEqual([1, 2, 3]);
    await loadFontFile(key, ok);
    expect(calls).toBe(1);
    const nf = (async () => new Response("x", { status: 404 })) as unknown as typeof fetch;
    expect(await loadFontFile((14 << 8) | 2, nf)).toBeNull();
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await loadFontFile((13 << 8) | 3, boom)).toBeNull();
    expect(await loadFontFile(0)).toBeNull();
  });
});
