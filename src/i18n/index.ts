// i18n-Schicht — eine einzige Übersetzungsfunktion `t(key, params?)` plus ein
// optionaler React-Hook `useT`. Default-Sprache ist Deutsch; das deutsche
// Wörterbuch (de.ts) hält die EXAKTEN bisherigen UI-Texte, sodass die Umstellung
// optisch nichts ändert. en.ts beweist die Übersetzbarkeit.
//
// Bewusst minimal gehalten: ein modulweiter „current language" + Wörterbuch-
// Lookup mit {param}-Interpolation. Kein Provider-Zwang — t(...) ist überall
// direkt aufrufbar; useT() liefert dieselbe Funktion und re-rendert Komponenten
// beim Sprachwechsel (subscribe), falls je ein Umschalter gebaut wird.
//
// Identifier/Keys bleiben englisch (DOSSIER-Namespacing); nur die Wörterbuch-
// Werte sind übersetzbarer Text.

import { useSyncExternalStore } from "react";
import { de } from "./de";
import { en } from "./en";
import type { TranslationKey } from "./de";

export type { TranslationKey } from "./de";

/** Unterstützte Sprachen. Default ist „de". */
export type Language = "de" | "en";

/** Wörterbücher je Sprache. de ist die Quelle der Keys (Default-Sprache). */
const DICTS: Record<Language, Record<TranslationKey, string>> = { de, en };

/** Werte für die Platzhalter-Interpolation (`{name}` → params.name). */
export type TParams = Record<string, string | number>;

// ── Modulweiter Sprachzustand + Abonnenten (für useT) ──────────────────────

let currentLanguage: Language = "de";
const listeners = new Set<() => void>();

/** Aktuell gewählte Sprache. */
export function getLanguage(): Language {
  return currentLanguage;
}

/**
 * Sprache umschalten. Benachrichtigt abonnierte Komponenten (useT), damit sie
 * mit den neuen Texten neu rendern. (Noch kein UI-Umschalter — die Naht ist
 * aber vorhanden und verdrahtet.)
 */
export function setLanguage(lang: Language): void {
  if (lang === currentLanguage) return;
  currentLanguage = lang;
  for (const l of listeners) l();
}

// ── Kern: Lookup + Interpolation ───────────────────────────────────────────

/** Ersetzt `{name}`-Platzhalter im Wert durch die übergebenen Parameter. */
function interpolate(value: string, params?: TParams): string {
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Übersetzt einen Key in der aktuellen Sprache mit optionaler {param}-
 * Interpolation. Fehlt der Key in der gewählten Sprache, greift Deutsch als
 * Fallback; fehlt er auch dort, wird der Key selbst zurückgegeben (sichtbar,
 * damit fehlende Texte auffallen statt leer zu bleiben).
 */
export function t(key: TranslationKey | string, params?: TParams): string {
  const dict = DICTS[currentLanguage];
  const value =
    (dict as Record<string, string>)[key] ??
    (de as Record<string, string>)[key] ??
    key;
  return interpolate(value, params);
}

// ── React-Hook ─────────────────────────────────────────────────────────────

/**
 * Hook-Variante: liefert dieselbe `t`-Funktion, abonniert aber den
 * Sprachzustand, sodass die Komponente beim Sprachwechsel neu rendert. In den
 * meisten Komponenten reicht der direkte `t`-Import; useT() ist für den Fall
 * gedacht, dass ein Live-Sprachumschalter existiert.
 */
export function useT(): typeof t {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getLanguage,
    getLanguage,
  );
  return t;
}
