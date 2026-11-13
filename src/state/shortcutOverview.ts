// [210] Kürzel-Übersicht (Hilfe → Tastaturkürzel): leitet die Liste aus den echten Tabellen ab —
// Tastenkombinationen aus `SHORTCUT_DEFS` (mit Nutzer-Übersteuerungen) und Befehlskürzel aus der Befehls-
// Registry (`ALIASES` + Nutzer-Kürzel). Nichts wird von Hand gepflegt; neue Kürzel erscheinen von selbst.
// Reine Funktion (kein React), Anzeige in `ui/ShortcutOverviewDialog.tsx`.

import { ALIASES, COMMANDS } from "../commands/registry";
import {
  SHORTCUT_DEFS,
  formatCombo,
  resolveCombo,
  type ShortcutCategory,
  type ShortcutOverrides,
} from "./keyboardShortcuts";

export interface ComboRow {
  /** i18n-Key der Aktion (`shortcut.<id>`). */
  labelKey: string;
  /** Anzeige der Kombination, plattformabhängig (⌘⇧Z / Strg+Umschalt+Z). */
  combo: string;
}

export interface ComboGroup {
  category: ShortcutCategory;
  rows: ComboRow[];
}

export interface CommandRow {
  /** Befehlsname (englisch, wie in der Befehlszeile getippt). */
  name: string;
  /** i18n-Key der Befehlsbezeichnung. */
  labelKey: string;
  /** Alle Kürzel (Nutzer-Kürzel zuerst), die zu diesem Befehl führen. */
  aliases: string[];
}

export interface ShortcutOverview {
  combos: ComboGroup[];
  commands: CommandRow[];
}

const CATEGORY_ORDER: ShortcutCategory[] = ["general", "selection", "edit", "boolean", "transform", "group", "tools", "navigation"];

export function buildShortcutOverview(
  comboOverrides: ShortcutOverrides = {},
  aliasOverrides: Record<string, string> = {},
  mac?: boolean,
): ShortcutOverview {
  const combos: ComboGroup[] = CATEGORY_ORDER.map((category) => ({
    category,
    rows: SHORTCUT_DEFS.filter((d) => d.category === category).map((d) => ({
      labelKey: d.labelKey,
      combo: formatCombo(resolveCombo(d.id, comboOverrides), mac),
    })),
  })).filter((g) => g.rows.length > 0);

  // Nutzer-Kürzel überschreiben eingebaute mit gleichem Schlüssel (wie `resolveCommand`).
  const merged: Record<string, string> = { ...ALIASES, ...aliasOverrides };
  const byCommand = new Map<string, string[]>();
  for (const [alias, name] of Object.entries(merged)) {
    // Kürzel, die selbst ein Befehlsname sind, kommen nicht in die Liste (der Name gewinnt in `resolveCommand`).
    if (!COMMANDS[name] || COMMANDS[alias]) continue;
    const list = byCommand.get(name) ?? [];
    list.push(alias);
    byCommand.set(name, list);
  }
  const rank = (a: string) => (a in aliasOverrides ? 0 : 1);
  const commands: CommandRow[] = [...byCommand.entries()]
    .map(([name, aliases]) => ({
      name,
      labelKey: COMMANDS[name].labelKey as string,
      aliases: aliases.sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { combos, commands };
}
