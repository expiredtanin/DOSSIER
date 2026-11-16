// [264] Sprachwahl der Oberfläche: „Automatisch (System)“, Deutsch oder English. Die Wahl liegt wie die
// übrigen App-Einstellungen (Hell/Dunkel, Offline) in localStorage und gilt app-weit; `applyLanguagePref`
// setzt die Sprache SOFORT (abonnierte Komponenten rendern neu), main.tsx ruft es vor dem ersten Render.
// Gespeichert wird nur die Wahl, nie übersetzte Projektdaten.

import { setLanguage, type Language } from "./translate";

export type LanguagePref = "auto" | "de" | "en";

export const LANGUAGE_PREFS: readonly LanguagePref[] = ["auto", "de", "en"];

const STORAGE_KEY = "dossier.language";

function isPref(v: unknown): v is LanguagePref {
  return v === "auto" || v === "de" || v === "en";
}

/** Gespeicherte Wahl; ohne gültigen Eintrag (oder ohne Speicher) „auto“. */
export function getStoredLanguagePref(): LanguagePref {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isPref(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

export function setStoredLanguagePref(pref: LanguagePref): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* Speicher gesperrt (Privatfenster): Wahl gilt nur bis zum Neustart */
  }
}

/** Systemsprachen des Browsers/der WebView (`navigator.languages`), leer ohne Navigator. */
function systemLocales(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/**
 * Sprache zur Wahl. „auto“ nimmt die erste Systemsprache, die Dossier kann (de-* → Deutsch, en-* → English);
 * kann keine, gilt Deutsch (Hauptmarkt, Vorgabe der App).
 */
export function resolveLanguage(pref: LanguagePref, locales: readonly string[] = systemLocales()): Language {
  if (pref !== "auto") return pref;
  for (const l of locales) {
    const base = l.toLowerCase().split("-")[0];
    if (base === "de" || base === "en") return base;
  }
  return "de";
}

/** Setzt die Oberflächensprache aus der Wahl (sofort wirksam) und `<html lang>`. */
export function applyLanguagePref(pref: LanguagePref): Language {
  const lang = resolveLanguage(pref);
  setLanguage(lang);
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  return lang;
}
