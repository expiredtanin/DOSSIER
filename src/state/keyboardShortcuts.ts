// Registry + Nutzer-Übersteuerungen für die GLOBALEN Tastatur-Shortcuts
// (Undo/Redo, Alles-wählen, Löschen, Split/Join, Kopieren/Einfügen, Boolean-
// Ops, Bewegen/Spiegeln/Drehen/Messen, Gruppieren, Werkzeug-Zifferntasten).
// Nutzer-Wunsch: „Einstellungen vollständiger machen, damit man eigene
// Shortcuts setzen kann" — bisher waren alle Kombinationen hart in
// `useKeyboardShortcuts.ts` verdrahtet (literale `e.key`/`e.ctrlKey`-Checks,
// keine Indirektion). ACHTUNG Abgrenzung zu `commandAliasOverrides.ts`: DAS
// dort sind Tipp-Kürzel für die Befehlszeile („w" → wall); DIESES Modul sind
// echte `keydown`-Tastenkombinationen (Ctrl/Cmd+Z usw.).
//
// Bewusst NICHT rebindbar (bleiben hart codiert, kollidieren sonst mit
// Kontext-Verhalten, das gar nicht über dieses Registry läuft): Tab/Enter/
// Escape/Backspace als Werkzeug-Steuerung (Feld-Zyklus, Gesten-Abschluss,
// Punkt zurücknehmen, Entwurf verwerfen) sowie die Ctrl/Cmd+Y-Redo- und
// Backspace-Löschen-ZUSATZ-Bindungen (bleiben als fixe Zweit-Belegung neben
// der hier konfigurierbaren Haupt-Kombination bestehen, s. `useUndoRedoShortcut`/
// `useSelectAllAndDeleteShortcut`).
//
// Reine Logik (Parsen/Matchen/Formatieren/Persistenz); die React-Anbindung
// (Laden beim Start, Weiterreichen an die Hooks, Cross-Fenster-`storage`-
// Sync) bleibt in App.tsx — exaktes Muster wie `commandAliasOverrides.ts`.
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

export type ShortcutId =
  | "undo"
  | "redo"
  | "selectAll"
  | "deleteSelection"
  | "split"
  | "join"
  | "copyElements"
  | "pasteElements"
  | "booleanUnion"
  | "booleanDifference"
  | "booleanIntersection"
  | "transformMove"
  | "transformMirror"
  | "transformRotate"
  | "measure"
  | "group"
  | "ungroup"
  | "toolText"
  | "toolLine"
  | "toolCircle"
  | "toolRect"
  | "toolPolyline"
  | "toolWall"
  | "toolCeiling"
  | "toolWindow"
  | "toolDoor"
  | "toolRoom";

export type ShortcutCategory =
  | "general"
  | "selection"
  | "edit"
  | "boolean"
  | "transform"
  | "group"
  | "tools";

export interface ShortcutDef {
  id: ShortcutId;
  category: ShortcutCategory;
  /** i18n-Key für die Aktions-Beschriftung, s. `shortcut.<id>` in de.ts/en.ts. */
  labelKey: string;
  defaultCombo: string;
  /** Bare-Key-Shortcuts (Werkzeug-/Transform-Kürzel): die Remap-UI verweigert
   * hier eine Kombination MIT Modifikator (Ctrl/Shift/Alt bleiben frei fürs
   * Tippen/OS-Kürzel — dieselbe Einschränkung, die die Hooks vorher schon
   * hart hatten). */
  bareKeyOnly?: boolean;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: "undo", category: "general", labelKey: "shortcut.undo", defaultCombo: "mod+z" },
  { id: "redo", category: "general", labelKey: "shortcut.redo", defaultCombo: "mod+shift+z" },
  { id: "selectAll", category: "selection", labelKey: "shortcut.selectAll", defaultCombo: "mod+a" },
  {
    id: "deleteSelection",
    category: "selection",
    labelKey: "shortcut.deleteSelection",
    defaultCombo: "Delete",
  },
  { id: "split", category: "edit", labelKey: "shortcut.split", defaultCombo: "mod+s" },
  { id: "join", category: "edit", labelKey: "shortcut.join", defaultCombo: "mod+j" },
  { id: "copyElements", category: "edit", labelKey: "shortcut.copyElements", defaultCombo: "mod+c" },
  { id: "pasteElements", category: "edit", labelKey: "shortcut.pasteElements", defaultCombo: "mod+v" },
  {
    id: "booleanUnion",
    category: "boolean",
    labelKey: "shortcut.booleanUnion",
    defaultCombo: "mod+shift+u",
  },
  {
    id: "booleanDifference",
    category: "boolean",
    labelKey: "shortcut.booleanDifference",
    defaultCombo: "mod+shift+d",
  },
  {
    id: "booleanIntersection",
    category: "boolean",
    labelKey: "shortcut.booleanIntersection",
    defaultCombo: "mod+shift+i",
  },
  {
    id: "transformMove",
    category: "transform",
    labelKey: "shortcut.transformMove",
    defaultCombo: "m",
    bareKeyOnly: true,
  },
  {
    id: "transformMirror",
    category: "transform",
    labelKey: "shortcut.transformMirror",
    defaultCombo: "s",
    bareKeyOnly: true,
  },
  {
    id: "transformRotate",
    category: "transform",
    labelKey: "shortcut.transformRotate",
    defaultCombo: "d",
    bareKeyOnly: true,
  },
  {
    id: "measure",
    category: "transform",
    labelKey: "shortcut.measure",
    defaultCombo: "q",
    bareKeyOnly: true,
  },
  { id: "group", category: "group", labelKey: "shortcut.group", defaultCombo: "mod+g" },
  { id: "ungroup", category: "group", labelKey: "shortcut.ungroup", defaultCombo: "mod+shift+g" },
  {
    id: "toolText",
    category: "tools",
    labelKey: "shortcut.toolText",
    defaultCombo: "1",
    bareKeyOnly: true,
  },
  {
    id: "toolLine",
    category: "tools",
    labelKey: "shortcut.toolLine",
    defaultCombo: "2",
    bareKeyOnly: true,
  },
  {
    id: "toolCircle",
    category: "tools",
    labelKey: "shortcut.toolCircle",
    defaultCombo: "3",
    bareKeyOnly: true,
  },
  {
    id: "toolRect",
    category: "tools",
    labelKey: "shortcut.toolRect",
    defaultCombo: "4",
    bareKeyOnly: true,
  },
  {
    id: "toolPolyline",
    category: "tools",
    labelKey: "shortcut.toolPolyline",
    defaultCombo: "5",
    bareKeyOnly: true,
  },
  {
    id: "toolWall",
    category: "tools",
    labelKey: "shortcut.toolWall",
    defaultCombo: "6",
    bareKeyOnly: true,
  },
  {
    id: "toolCeiling",
    category: "tools",
    labelKey: "shortcut.toolCeiling",
    defaultCombo: "7",
    bareKeyOnly: true,
  },
  {
    id: "toolWindow",
    category: "tools",
    labelKey: "shortcut.toolWindow",
    defaultCombo: "8",
    bareKeyOnly: true,
  },
  {
    id: "toolDoor",
    category: "tools",
    labelKey: "shortcut.toolDoor",
    defaultCombo: "9",
    bareKeyOnly: true,
  },
  {
    id: "toolRoom",
    category: "tools",
    labelKey: "shortcut.toolRoom",
    defaultCombo: "0",
    bareKeyOnly: true,
  },
];

const DEFS_BY_ID = new Map<ShortcutId, ShortcutDef>(SHORTCUT_DEFS.map((d) => [d.id, d]));

export function shortcutDef(id: ShortcutId): ShortcutDef {
  const def = DEFS_BY_ID.get(id);
  if (!def) throw new Error(`Unbekannte ShortcutId: ${id}`);
  return def;
}

export type ShortcutOverrides = Partial<Record<ShortcutId, string>>;

const STORAGE_KEY = "dossier.keyboardShortcutOverrides";

const KNOWN_IDS = new Set<string>(SHORTCUT_DEFS.map((d) => d.id));

/** Liest die gespeicherten Tastenkombinations-Übersteuerungen; `{}` ohne gespeicherten Wert oder bei kaputten Daten. */
export function loadShortcutOverrides(): ShortcutOverrides {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ShortcutOverrides = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (KNOWN_IDS.has(k) && typeof v === "string") out[k as ShortcutId] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Speichert die Tastenkombinations-Übersteuerungen (bestes Bemühen). */
export function saveShortcutOverrides(overrides: ShortcutOverrides): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Ignorieren (Quota/privates Fenster) — gleiche Bestes-Bemühen-Haltung wie
    // die übrigen localStorage-Einstellungen in diesem Projekt.
  }
}

/** Aktuell wirksame Kombination (Übersteuerung falls vorhanden, sonst Default). */
export function resolveCombo(id: ShortcutId, overrides: ShortcutOverrides): string {
  return overrides[id] ?? shortcutDef(id).defaultCombo;
}

const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt"]);

/**
 * Kombination aus einem `keydown`-Event für die Aufnahme-UI („nächste
 * Tastenkombination drücken"). `null`, solange nur ein reiner Modifikator
 * gedrückt ist (kein Ziel-Ereignis) — die UI wartet dann weiter.
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  parts.push(key);
  return parts.join("+");
}

/** Prüft ein `keydown`-Event gegen eine Kombinations-Zeichenkette (exakte Modifikator-Übereinstimmung). */
export function comboMatches(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const wantMod = mods.includes("mod");
  const wantShift = mods.includes("shift");
  const wantAlt = mods.includes("alt");
  if ((e.ctrlKey || e.metaKey) !== wantMod) return false;
  if (e.shiftKey !== wantShift) return false;
  if (e.altKey !== wantAlt) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return k === key;
}

/** Kurzform: matcht `e` gegen die (übersteuerte oder Default-)Kombination von `id`. */
export function matchesShortcut(
  e: KeyboardEvent,
  id: ShortcutId,
  overrides: ShortcutOverrides,
): boolean {
  return comboMatches(e, resolveCombo(id, overrides));
}

/** Ob `combo` bereits einer ANDEREN Aktion zugewiesen ist — für die Remap-UI (Kollisions-Warnung). */
export function findConflict(
  combo: string,
  excludeId: ShortcutId,
  overrides: ShortcutOverrides,
): ShortcutId | null {
  for (const def of SHORTCUT_DEFS) {
    if (def.id === excludeId) continue;
    if (resolveCombo(def.id, overrides) === combo) return def.id;
  }
  return null;
}

/** Bare-Keys, die system-weit fest für Werkzeug-/Gesten-Steuerung reserviert
 * sind (Tab-Feld-Zyklus, Enter-Commit, Escape-Abbruch) und NICHT als neue
 * Kombination vergeben werden dürfen — diese Tasten laufen ausserhalb dieses
 * Registrys, eine Neu-Zuweisung würde still ins Leere laufen (die alte
 * Kontext-Bindung bliebe unverändert bestehen, nur verwirrend doppelt belegt). */
const RESERVED_BARE_COMBOS = new Set(["Tab", "Enter", "Escape", "Backspace"]);

export function isReservedCombo(combo: string): boolean {
  return RESERVED_BARE_COMBOS.has(combo);
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}

const KEY_DISPLAY_LABELS: Record<string, string> = {
  Delete: "Entf",
  Backspace: "Rücktaste",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  " ": "Leertaste",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** Menschenlesbare Darstellung einer Kombination, plattformabhängig (⌘⇧Z auf macOS, Strg+Umschalt+Z sonst). */
export function formatCombo(combo: string, mac: boolean = isMacPlatform()): string {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const segs: string[] = [];
  if (mods.includes("mod")) segs.push(mac ? "⌘" : "Strg");
  if (mods.includes("shift")) segs.push(mac ? "⇧" : "Umschalt");
  if (mods.includes("alt")) segs.push(mac ? "⌥" : "Alt");
  const keyLabel = KEY_DISPLAY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  segs.push(keyLabel);
  return segs.join(mac ? "" : "+");
}
