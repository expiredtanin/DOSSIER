import { describe, expect, it } from "vitest";
import { buildShortcutOverview, FIXED_COMBO_ROWS } from "./shortcutOverview";
import { ALIASES, COMMANDS } from "../commands/registry";
import { SHORTCUT_DEFS } from "./keyboardShortcuts";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";

describe("[210] Kürzel-Übersicht", () => {
  const ov = buildShortcutOverview({}, {}, true);

  it("listet jede Tastenkombination der Registry genau einmal", () => {
    const n = ov.combos.reduce((s, g) => s + g.rows.length, 0);
    expect(n).toBe(SHORTCUT_DEFS.length + FIXED_COMBO_ROWS.length);
    const undo = ov.combos.flatMap((g) => g.rows).find((r) => r.labelKey === "shortcut.undo");
    expect(undo?.combo).toBe("⌘Z");
  });

  it("[252] Ctrl+Tab / Ctrl+Umschalt+Tab stehen fest in der Übersicht (auf dem Mac Ctrl)", () => {
    const rows = ov.combos.flatMap((g) => g.rows);
    expect(rows.find((r) => r.labelKey === "shortcut.nextViewTab")?.combo).toBe("⌃Tab");
    expect(buildShortcutOverview({}, {}, false).combos.flatMap((g) => g.rows).find((r) => r.labelKey === "shortcut.prevViewTab")?.combo).toBe("Strg+Umschalt+Tab");
  });

  it("zeigt Nutzer-Kombinationen statt der Vorgabe", () => {
    const o = buildShortcutOverview({ undo: "mod+u" }, {}, false);
    expect(o.combos.flatMap((g) => g.rows).find((r) => r.labelKey === "shortcut.undo")?.combo).toBe("Strg+U");
  });

  it("gruppiert die Befehlskürzel je Befehl, nur bekannte Befehle", () => {
    const wall = ov.commands.find((c) => c.name === "wall");
    expect(wall?.aliases).toContain("w");
    expect(wall?.aliases).toContain("wand");
    for (const c of ov.commands) expect(COMMANDS[c.name]).toBeDefined();
    for (const [alias, name] of Object.entries(ALIASES)) {
      if (!COMMANDS[name] || COMMANDS[alias]) continue;
      expect(ov.commands.find((c) => c.name === name)?.aliases).toContain(alias);
    }
  });

  it("Nutzer-Kürzel überschreiben eingebaute und stehen zuerst", () => {
    const o = buildShortcutOverview({}, { w: "line", zz: "wall" }, true);
    expect(o.commands.find((c) => c.name === "line")?.aliases[0]).toBe("w");
    expect(o.commands.find((c) => c.name === "wall")?.aliases).not.toContain("w");
    expect(o.commands.find((c) => c.name === "wall")?.aliases[0]).toBe("zz");
  });

  it("alle Beschriftungen sind übersetzt", () => {
    for (const g of ov.combos) for (const r of g.rows) expect(t(r.labelKey as TranslationKey)).not.toBe(r.labelKey);
    for (const c of ov.commands) expect(t(c.labelKey as TranslationKey)).not.toBe(c.labelKey);
  });
});
