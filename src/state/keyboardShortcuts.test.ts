import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
// [289] Die Tests gehen von Strg als Primär-Modifikator aus (Linux), egal auf welchem Rechner sie laufen.
beforeAll(() => vi.stubGlobal("navigator", { platform: "Linux x86_64", userAgent: "" }));
afterAll(() => vi.unstubAllGlobals());
import { setLanguage } from "../i18n";
import {
  comboFromEvent,
  comboMatches,
  fileShortcutFor,
  findConflict,
  formatCombo,
  isReservedCombo,
  tabKeyAction,
  matchesShortcut,
  resolveCombo,
  SHORTCUT_DEFS,
  type ShortcutOverrides,
  toolShortcutLabel,
} from "./keyboardShortcuts";

// Reines Objekt statt `new KeyboardEvent(...)` — Letzteres braucht ein DOM
// (im "node"-Vitest-Environment nicht vorhanden); `comboMatches`/`comboFromEvent`
// lesen ohnehin nur die vier Felder unten.
function key(
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
): KeyboardEvent {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
  } as KeyboardEvent;
}

describe("Speichern-Kürzel", () => {
  it("Mod+S und Mod+Shift+S sind für Speichern/Speichern unter frei (Teilen = Mod+Shift+J)", () => {
    const combos = SHORTCUT_DEFS.map((d) => d.defaultCombo);
    expect(combos).not.toContain("mod+s");
    expect(combos).not.toContain("mod+shift+s");
    expect(SHORTCUT_DEFS.find((d) => d.id === "split")?.defaultCombo).toBe("mod+shift+j");
  });
});

describe("SHORTCUT_DEFS", () => {
  it("hat für jede Id eine eindeutige Default-Kombination (keine eingebaute Kollision)", () => {
    const seen = new Map<string, string>();
    for (const def of SHORTCUT_DEFS) {
      const prev = seen.get(def.defaultCombo);
      expect(prev, `${def.defaultCombo} kollidiert: ${prev} vs ${def.id}`).toBeUndefined();
      seen.set(def.defaultCombo, def.id);
    }
  });
});

describe("[190] Archicad-Kürzel", () => {
  const combo = (id: string) => SHORTCUT_DEFS.find((d) => d.id === id)?.defaultCombo;
  it("belegt die neuen Kürzel ohne Kollision mit Werkzeug-Ziffern und Buchstaben", () => {
    expect(combo("duplicate")).toBe("mod+d");
    expect(combo("toggleLock")).toBe("mod+l");
    expect(combo("fitAll")).toBe("mod+0");
    expect(combo("fitSelection")).toBe("mod+shift+f");
    expect(combo("hideSelectionLayers")).toBe("mod+shift+h");
    expect(combo("showAllLayers")).toBe("mod+shift+a");
    // Kein Kürzel doppelt (auch nicht gegen m/s/d/q und 1–0).
    const all = SHORTCUT_DEFS.map((d) => d.defaultCombo);
    expect(new Set(all).size).toBe(all.length);
    // Cmd+D (Duplizieren) und d (Drehen) sind verschiedene Kombinationen.
    expect(matchesShortcut(key("d"), "duplicate", {})).toBe(false);
    expect(matchesShortcut(key("d", { ctrlKey: true }), "duplicate", {})).toBe(true);
    expect(matchesShortcut(key("d", { ctrlKey: true }), "transformRotate", {})).toBe(false);
  });
});

describe("comboMatches", () => {
  it("erkennt Ctrl/Cmd+Z (mod+z)", () => {
    expect(comboMatches(key("z", { ctrlKey: true }), "mod+z")).toBe(true);
    expect(comboMatches(key("z", { ctrlKey: true }), "mod+z")).toBe(true);
    expect(comboMatches(key("Z", { ctrlKey: true }), "mod+z")).toBe(true); // Grossbuchstabe (Caps/Shift-Ambiguität) egal
  });

  it("verlangt exakte Modifikator-Übereinstimmung (kein zusätzliches Shift)", () => {
    expect(comboMatches(key("z", { ctrlKey: true, shiftKey: true }), "mod+z")).toBe(false);
    expect(comboMatches(key("z", { ctrlKey: true, shiftKey: true }), "mod+shift+z")).toBe(true);
  });

  it("bare-Key ohne Modifikator matcht nur ohne jeden Modifikator", () => {
    expect(comboMatches(key("m"), "m")).toBe(true);
    expect(comboMatches(key("m", { ctrlKey: true }), "m")).toBe(false);
    expect(comboMatches(key("m", { shiftKey: true }), "m")).toBe(false);
  });

  it("Sondertasten (Delete) werden namentlich, nicht kleingeschrieben verglichen", () => {
    expect(comboMatches(key("Delete"), "Delete")).toBe(true);
    expect(comboMatches(key("Backspace"), "Delete")).toBe(false);
  });
});

describe("comboFromEvent", () => {
  it("liefert null bei reinem Modifikator-Tastendruck", () => {
    expect(comboFromEvent(key("Control"))).toBeNull();
    expect(comboFromEvent(key("Shift"))).toBeNull();
  });

  it("baut die Kombination in fester Reihenfolge mod+shift+alt+key", () => {
    expect(comboFromEvent(key("g", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+g");
    expect(comboFromEvent(key("G", { ctrlKey: true }))).toBe("mod+g");
    expect(comboFromEvent(key("q"))).toBe("q");
  });
});

describe("resolveCombo / matchesShortcut", () => {
  it("nutzt den Default ohne Übersteuerung", () => {
    expect(resolveCombo("undo", {})).toBe("mod+z");
    expect(matchesShortcut(key("z", { ctrlKey: true }), "undo", {})).toBe(true);
  });

  it("nutzt die Übersteuerung, sobald vorhanden", () => {
    const overrides: ShortcutOverrides = { undo: "mod+shift+u" };
    expect(resolveCombo("undo", overrides)).toBe("mod+shift+u");
    expect(matchesShortcut(key("z", { ctrlKey: true }), "undo", overrides)).toBe(false);
    expect(matchesShortcut(key("u", { ctrlKey: true, shiftKey: true }), "undo", overrides)).toBe(
      true,
    );
  });
});

describe("findConflict", () => {
  it("findet eine Kollision mit einer anderen Default-Kombination", () => {
    expect(findConflict("mod+a", "undo", {})).toBe("selectAll");
  });

  it("ignoriert die eigene Id", () => {
    expect(findConflict("mod+z", "undo", {})).toBeNull();
  });

  it("berücksichtigt bereits gesetzte Übersteuerungen anderer Ids", () => {
    const overrides: ShortcutOverrides = { redo: "mod+r" };
    expect(findConflict("mod+r", "undo", overrides)).toBe("redo");
  });
});

describe("isReservedCombo", () => {
  it("verweigert die fest reservierten Steuer-Tasten", () => {
    expect(isReservedCombo("Tab")).toBe(true);
    expect(isReservedCombo("Enter")).toBe(true);
    expect(isReservedCombo("Escape")).toBe(true);
    expect(isReservedCombo("Backspace")).toBe(true);
  });

  it("erlaubt normale Kombinationen", () => {
    expect(isReservedCombo("mod+z")).toBe(false);
    expect(isReservedCombo("m")).toBe(false);
  });
});

describe("formatCombo", () => {
  it("macOS-Darstellung: Symbole ohne Trenner", () => {
    expect(formatCombo("mod+shift+z", true)).toBe("⌘⇧Z");
  });

  it("Nicht-macOS-Darstellung: Wörter mit +", () => {
    expect(formatCombo("mod+shift+z", false)).toBe("Strg+Umschalt+Z");
  });

  it("Englisch: Ctrl/Shift/Del statt Strg/Umschalt/Entf", () => {
    setLanguage("en");
    try {
      expect(formatCombo("mod+shift+Tab", false)).toBe("Ctrl+Shift+Tab");
      expect(formatCombo("Delete", false)).toBe("Del");
      expect(formatCombo("mod+shift+z", true)).toBe("⌘⇧Z");
    } finally {
      setLanguage("de");
    }
  });

  it("Sondertasten bekommen ein lesbares Label", () => {
    expect(formatCombo("Delete", false)).toBe("Entf");
  });

  it("bare-Key bleibt Grossbuchstabe ohne Modifikator-Präfix", () => {
    expect(formatCombo("m", false)).toBe("M");
  });
});

// `loadShortcutOverrides`/`saveShortcutOverrides` sind localStorage-gekoppelt
// und bleiben — wie `loadAliasOverrides`/`saveAliasOverrides` (s.
// commandAliasOverrides.test.ts) — ohne dediziertes Unit-Test (window/
// localStorage im "node"-Vitest-Environment nicht vorhanden); beide sind
// bewusst defensiv (try/catch, No-op statt Absturz).

describe("[252] tabKeyAction", () => {
  const ev = (o: Partial<KeyboardEvent>) => ({ key: "Tab", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  it("Tab und Umschalt+Tab gehören der Befehlszeile", () => {
    expect(tabKeyAction(ev({}))).toBe("commandLine");
    expect(tabKeyAction(ev({ shiftKey: true }))).toBe("commandLine");
  });
  it("Ctrl+Tab vorwärts, Ctrl+Umschalt+Tab rückwärts", () => {
    expect(tabKeyAction(ev({ ctrlKey: true }))).toBe("nextViewTab");
    expect(tabKeyAction(ev({ ctrlKey: true, shiftKey: true }))).toBe("prevViewTab");
  });
  it("Cmd+Tab und Alt+Tab gehören dem System, andere Tasten nicht", () => {
    expect(tabKeyAction(ev({ metaKey: true }))).toBeNull();
    expect(tabKeyAction(ev({ altKey: true }))).toBeNull();
    expect(tabKeyAction(ev({ key: "a", ctrlKey: true }))).toBeNull();
  });
});

describe("[170] Datei-Kürzel ausserhalb von Tauri (Browser/Electron-Linux)", () => {
  it("Strg/Cmd+S speichert, +Umschalt speichert unter, Strg/Cmd+O öffnet", () => {
    expect(fileShortcutFor(key("s", { ctrlKey: true }))).toBe("save");
    expect(fileShortcutFor(key("s", { metaKey: true }))).toBeNull(); // [289] Super/Meta ist unter Linux kein Primär-Modifikator
    expect(fileShortcutFor(key("S", { ctrlKey: true, shiftKey: true }))).toBe("saveAs");
    expect(fileShortcutFor(key("o", { ctrlKey: true }))).toBe("open");
  });
  it("ohne Strg/Cmd oder mit Alt: nichts (s = Spiegeln bleibt frei)", () => {
    expect(fileShortcutFor(key("s"))).toBeNull();
    expect(fileShortcutFor(key("s", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(fileShortcutFor(key("o", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });
  it("kollidiert mit keinem belegbaren Kürzel", () => {
    const combos = SHORTCUT_DEFS.map((d) => d.defaultCombo);
    for (const c of ["mod+s", "mod+shift+s", "mod+o"]) expect(combos).not.toContain(c);
  });
});

describe("toolShortcutLabel", () => {
  // [287] (12) Werkzeug-Tooltips mit Kürzel; Übersteuerung gilt, Werkzeug ohne Kürzel `null`.
  it("zeigt das wirksame Kürzel", () => {
    const def = toolShortcutLabel("wall", {});
    expect(def).toBeTruthy();
    expect(toolShortcutLabel("wall", { toolWall: "shift+w" })).toMatch(/W$/);
    expect(toolShortcutLabel("gibts-nicht", {})).toBeNull();
  });
});
