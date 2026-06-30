// Sichtbarkeits-Kombinationen — Persistenz (localStorage).
//
// Speichert benannte Sichtbarkeits-Sätze (Vectorworks: „Ebenenkombinationen"
// / „Zeichnungskombinationen") für zwei unabhängige Achsen:
//   • Ebenen-Kombination  (LayerCombo)   — pro Kategorie-`code` → sichtbar?
//   • Zeichnungs-Komb.     (DrawingCombo) — pro DrawingLevel-`id` → sichtbar?
//
// Analog zu panels/layout.ts: reine Speicher-Helfer OHNE React-Abhängigkeit,
// sämtlicher localStorage-Zugriff in try/catch + storage()-Guard (SSR/Tests/
// Privatmodus). Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).
//
// Hinweis: Diese Sätze liegen (wie die benannten Layouts) im localStorage und
// sind damit GERÄTE-/Browser-lokal, nicht im Projekt-Modell. Sollen sie mit dem
// Projekt mitwandern (Export/Teilen), gehören sie später ins `Project` (siehe
// Report).

/** Eine gespeicherte Ebenen-Kombination: Kategorie-Code → sichtbar?. */
export interface LayerCombo {
  codes: Record<string, boolean>;
}

/** Eine gespeicherte Zeichnungs-Kombination: DrawingLevel-Id → sichtbar?. */
export interface DrawingCombo {
  ids: Record<string, boolean>;
}

/** Präfix der localStorage-Schlüssel für Ebenen-Kombinationen. */
const LAYER_PREFIX = "cad.layercombos.";
/** Präfix der localStorage-Schlüssel für Zeichnungs-Kombinationen. */
const DRAWING_PREFIX = "cad.drawingcombos.";

// ── localStorage-Sicherung (wie panels/layout.ts) ───────────────────────────

/** Liefert das localStorage-Objekt oder `null`, wenn nicht verfügbar. */
function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Zugriff kann werfen (z. B. blockierte Cookies/Privatmodus).
    return null;
  }
}

/** Liest und parst einen JSON-Wert; `null` bei Fehlen/ungültig. */
function readJson<T>(key: string): T | null {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Schreibt einen JSON-Wert; liefert `false`, wenn das Schreiben scheitert. */
function writeJson(key: string, value: unknown): boolean {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Kontingent überschritten oder Zugriff verweigert — still ignorieren.
    return false;
  }
}

/** Löscht einen Schlüssel; liefert `true`, wenn der Zugriff gelang. */
function removeKey(key: string): boolean {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Listet alle Namen unter einem Präfix (alphabetisch sortiert). */
function listNames(prefix: string): string[] {
  const ls = storage();
  if (!ls) return [];
  const names: string[] = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (key && key.startsWith(prefix)) {
        names.push(key.slice(prefix.length));
      }
    }
  } catch {
    return [];
  }
  return names.sort();
}

/**
 * Typwächter für eine `Record<string, boolean>`-Map (toleriert Fremddaten aus
 * localStorage). Liefert eine bereinigte Map (nur boolesche Werte), sonst `null`.
 */
function asBoolMap(v: unknown): Record<string, boolean> | null {
  if (typeof v !== "object" || v === null) return null;
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "boolean") out[k] = val;
  }
  return out;
}

// ── Ebenen-Kombinationen ─────────────────────────────────────────────────────

/** Speichert eine Ebenen-Kombination unter einem Namen. `true` bei Erfolg. */
export function saveLayerCombo(
  name: string,
  codes: Record<string, boolean>,
): boolean {
  if (!name) return false;
  const value: LayerCombo = { codes };
  return writeJson(LAYER_PREFIX + name, value);
}

/**
 * Lädt eine Ebenen-Kombination (nur die `codes`-Map). Fehlt sie oder ist sie
 * beschädigt, kommt `null` zurück (so erkennt der Aufrufer „nicht gefunden").
 */
export function loadLayerCombo(name: string): Record<string, boolean> | null {
  const raw = readJson<unknown>(LAYER_PREFIX + name);
  if (raw === null || typeof raw !== "object") return null;
  return asBoolMap((raw as { codes?: unknown }).codes);
}

/** Listet die Namen aller gespeicherten Ebenen-Kombinationen (alphabetisch). */
export function listLayerCombos(): string[] {
  return listNames(LAYER_PREFIX);
}

/** Löscht eine Ebenen-Kombination. `true`, wenn der Zugriff gelang. */
export function deleteLayerCombo(name: string): boolean {
  return removeKey(LAYER_PREFIX + name);
}

// ── Zeichnungs-Kombinationen ─────────────────────────────────────────────────

/** Speichert eine Zeichnungs-Kombination unter einem Namen. `true` bei Erfolg. */
export function saveDrawingCombo(
  name: string,
  ids: Record<string, boolean>,
): boolean {
  if (!name) return false;
  const value: DrawingCombo = { ids };
  return writeJson(DRAWING_PREFIX + name, value);
}

/**
 * Lädt eine Zeichnungs-Kombination (nur die `ids`-Map). Fehlt sie oder ist sie
 * beschädigt, kommt `null` zurück.
 */
export function loadDrawingCombo(name: string): Record<string, boolean> | null {
  const raw = readJson<unknown>(DRAWING_PREFIX + name);
  if (raw === null || typeof raw !== "object") return null;
  return asBoolMap((raw as { ids?: unknown }).ids);
}

/** Listet die Namen aller gespeicherten Zeichnungs-Kombinationen (alphabetisch). */
export function listDrawingCombos(): string[] {
  return listNames(DRAWING_PREFIX);
}

/** Löscht eine Zeichnungs-Kombination. `true`, wenn der Zugriff gelang. */
export function deleteDrawingCombo(name: string): boolean {
  return removeKey(DRAWING_PREFIX + name);
}
