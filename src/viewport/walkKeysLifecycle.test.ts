import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// [118][245] Der Tasten-Hörer des Begehens (G, WASD, Umschalt+F) darf nicht vom Renderer-Lebenszyklus abhängen: In der Probezeit nach einem
// Geräteverlust ist weder `ready` noch `failed` gesetzt, dort fehlte der Hörer und „G“ blieb wirkungslos (e2e walk/a11yNewDialogs flackerten).
describe("Begehen-Tasten ohne Renderer-Zustand", () => {
  const src = readFileSync(new URL("./Wasm3DViewport.tsx", import.meta.url), "utf8");
  const at = src.indexOf("walkKickRef.current = null;");
  const deps = /\}, \[([^\]]*)\]\);/.exec(src.slice(at, at + 120))?.[1] ?? "?";

  it("Effekt hängt nicht an ready/failed/walkInput", () => {
    expect(at).toBeGreaterThan(0);
    expect(deps).not.toBe("?");
    expect(deps).not.toMatch(/ready|failed|walkInput/);
  });
  it("kein Frühausstieg über den Renderer-Zustand", () => {
    expect(src).not.toMatch(/if \(!walkInput\) return;/);
    expect(src).not.toMatch(/const walkInput = ready \|\| failed/);
  });
});
