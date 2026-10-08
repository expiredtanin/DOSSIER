// Nutzer-Kürzel-Übersteuerungen für die Befehlszeile (Nutzer-Wunsch: „Befehls-
// Kürzel sind hart codiert (`commands/registry.ts` ALIASES), keine Remap-UI").
// Persistiert in localStorage (GERÄT-/Profil-weite Einstellung, wie Theme/
// Renderer-Modus — kein Projekt-Feld, da es um die TIPP-Gewohnheit des
// Nutzers geht, nicht um Projektinhalt). Ein Eintrag `{taste: befehlsname}`
// überschreibt (nur für DIESEN Nutzer) das eingebaute Kürzel mit demselben
// Schlüssel, falls eins existiert — s. `commands/registry.ts::resolveCommand`.
//
// Reine Lese-/Schreib-/Validierungsfunktionen; die React-/Engine-Anbindung
// (laden beim Start, `engine.setAliasOverrides(...)` bei jeder Änderung)
// bleibt in App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

const STORAGE_KEY = "cad.commandAliasOverrides";

/** Liest die gespeicherten Kürzel-Übersteuerungen; `{}` ohne gespeicherten Wert oder bei kaputten Daten. */
export function loadAliasOverrides(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Speichert die Kürzel-Übersteuerungen (bestes Bemühen — schlägt z. B. im privaten Fenster still fehl). */
export function saveAliasOverrides(overrides: Record<string, string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Ignorieren (Quota/privates Fenster) — dieselbe Bestes-Bemühen-Haltung wie
    // die übrigen localStorage-Einstellungen in diesem Projekt.
  }
}

/**
 * Ist `key` als NEUER (oder geänderter) Kürzel-Eintrag gültig? Getrimmt,
 * nicht leer, keine Leerzeichen/Kommas (würde mit der Koordinaten-/Options-
 * Eingabe der Befehlszeile kollidieren) und NICHT `r…` (kollidiert mit dem
 * relativ-Koordinaten-Präfix, dieselbe Ausnahme wie bei den eingebauten
 * Kürzeln, s. Kopfkommentar von `ALIASES` in `registry.ts`).
 */
export function isValidAliasKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (k.length === 0) return false;
  if (/[\s,]/.test(k)) return false;
  if (k === "r" || /^r\d/.test(k)) return false;
  return true;
}
