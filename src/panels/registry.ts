// Panel-Registry — die Plugin-Naht.
//
// Modulweites Verzeichnis aller bekannten Panels. Kern-Panels und Plugins/
// eigene Panels rufen `registerPanel` (typisch beim Import ihres Moduls) auf;
// die Docks fragen anschließend über `getPanel`/`listPanels` ab. So bleibt der
// Rahmen offen für Erweiterungen, ohne ihn zu ändern.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { PanelDef } from "./types";

/** Modulweites Verzeichnis: Panel-ID → Definition (Einfügereihenfolge bewahrt). */
const registry = new Map<string, PanelDef>();

/**
 * Registriert ein Panel. Idempotent pro ID: ein erneuter Aufruf mit derselben
 * ID ersetzt die vorhandene Definition (praktisch für Hot-Reload und für
 * Plugins, die Kern-Panels überschreiben). Liefert die übergebene Definition
 * zurück, damit Aufrufe verkettet werden können.
 */
export function registerPanel(def: PanelDef): PanelDef {
  registry.set(def.id, def);
  return def;
}

/** Liefert die registrierte Panel-Definition zur ID oder `undefined`. */
export function getPanel(id: string): PanelDef | undefined {
  return registry.get(id);
}

/** Liefert alle registrierten Panels in Registrierungsreihenfolge. */
export function listPanels(): PanelDef[] {
  return [...registry.values()];
}

/**
 * Ob zu einer ID ein Panel registriert ist. Hilfreich, um aus einem
 * persistierten Layout verschwundene (z. B. von einem deaktivierten Plugin
 * stammende) Panel-IDs herauszufiltern.
 */
export function hasPanel(id: string): boolean {
  return registry.has(id);
}

/**
 * Entfernt ein Panel aus der Registry. Liefert `true`, wenn etwas entfernt
 * wurde. Vor allem für Tests und das Entladen von Plugins gedacht.
 */
export function unregisterPanel(id: string): boolean {
  return registry.delete(id);
}
