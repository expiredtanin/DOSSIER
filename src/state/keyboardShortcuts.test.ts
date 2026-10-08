import { describe, expect, it } from "vitest";
import {
  comboFromEvent,
  comboMatches,
  findConflict,
  formatCombo,
  isReservedCombo,
  matchesShortcut,
  resolveCombo,
  SHORTCUT_DEFS,
  type ShortcutOverrides,
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

describe("comboMatches", () => {
  it("erkennt Ctrl/Cmd+Z (mod+z)", () => {
    expect(comboMatches(key("z", { ctrlKey: true }), "mod+z")).toBe(true);
    expect(comboMatches(key("z", { metaKey: true }), "mod+z")).toBe(true);
    expect(comboMatches(key("Z", { metaKey: true }), "mod+z")).toBe(true); // Grossbuchstabe (Caps/Shift-Ambiguität) egal
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
    expect(comboFromEvent(key("g", { metaKey: true, shiftKey: true }))).toBe("mod+shift+g");
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
