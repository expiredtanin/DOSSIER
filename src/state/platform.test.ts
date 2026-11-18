// [289] Primär-Modifikator je Plattform und die Zuordnung der Datei-/Zoom-Kürzel.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPrimaryMod, platformName } from "./platform";
import { comboMatches, fileShortcutFor, formatCombo } from "./keyboardShortcuts";

const ev = (init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent =>
  ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

function platform(p: string, ua = "") {
  vi.stubGlobal("navigator", { platform: p, userAgent: ua });
}
afterEach(() => vi.unstubAllGlobals());

describe("isPrimaryMod", () => {
  it("Mac: nur Cmd; sonst nur Strg", () => {
    expect(isPrimaryMod({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isPrimaryMod({ ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(isPrimaryMod({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(isPrimaryMod({ ctrlKey: false, metaKey: true }, false)).toBe(false);
  });
});

describe("Kürzel je Plattform", () => {
  it("Linux: Strg+Z/Umschalt+Strg+Z/S/N/P gelten, Super nicht", () => {
    platform("Linux x86_64", "X11; Linux x86_64");
    expect(platformName()).toBe("linux");
    expect(comboMatches(ev({ key: "z", ctrlKey: true }), "mod+z")).toBe(true);
    expect(comboMatches(ev({ key: "Z", ctrlKey: true, shiftKey: true }), "mod+shift+z")).toBe(true);
    expect(comboMatches(ev({ key: "z", metaKey: true }), "mod+z")).toBe(false);
    expect(fileShortcutFor(ev({ key: "s", ctrlKey: true }))).toBe("save");
    expect(fileShortcutFor(ev({ key: "S", ctrlKey: true, shiftKey: true }))).toBe("saveAs");
    expect(fileShortcutFor(ev({ key: "o", ctrlKey: true }))).toBe("open");
    expect(fileShortcutFor(ev({ key: "n", ctrlKey: true }))).toBe("new");
    expect(fileShortcutFor(ev({ key: "p", ctrlKey: true }))).toBe("print");
    expect(fileShortcutFor(ev({ key: "q", ctrlKey: true }))).toBe("quit");
    expect(fileShortcutFor(ev({ key: "=", ctrlKey: true }))).toBe("zoomIn");
    expect(fileShortcutFor(ev({ key: "+", ctrlKey: true, shiftKey: true }))).toBe("zoomIn");
    expect(fileShortcutFor(ev({ key: "-", ctrlKey: true }))).toBe("zoomOut");
    expect(fileShortcutFor(ev({ key: "s", metaKey: true }))).toBeNull();
    expect(fileShortcutFor(ev({ key: "s" }))).toBeNull();
  });
  it("Mac: Cmd gilt, Ctrl nicht", () => {
    platform("MacIntel", "Macintosh");
    expect(platformName()).toBe("mac");
    expect(comboMatches(ev({ key: "z", metaKey: true }), "mod+z")).toBe(true);
    expect(comboMatches(ev({ key: "z", ctrlKey: true }), "mod+z")).toBe(false);
    expect(fileShortcutFor(ev({ key: "s", metaKey: true }))).toBe("save");
    expect(fileShortcutFor(ev({ key: "s", ctrlKey: true }))).toBeNull();
  });
  it("Anzeige: Strg+S unter Linux, ⌘S auf dem Mac", () => {
    platform("Linux x86_64");
    expect(formatCombo("mod+s")).toMatch(/^(Strg|Ctrl)\+S$/);
    platform("MacIntel");
    expect(formatCombo("mod+s")).toBe("⌘S");
  });
});
