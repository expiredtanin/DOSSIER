// Liste zuletzt geöffneter/gespeicherter Projektdateien für den Startbildschirm
// (s. ui/StartScreen.tsx). Nur Pfade + Metadaten, lokal in localStorage — der
// Dateiinhalt selbst wird erst beim Anklicken über den echten Pfad geladen
// (io/projectFile.ts), damit die Liste nie mit dem Dateiinhalt auseinanderläuft.
// Nur unter Tauri sinnvoll (echte Dateipfade); im Browser bleibt sie leer.

const STORAGE_KEY = "dossier.recentProjects";
const MAX_ENTRIES = 8;

export interface RecentProjectEntry {
  path: string;
  name: string;
  /** ISO-Zeitstempel des letzten Öffnens/Speicherns. */
  openedAt: string;
}

function readAll(): RecentProjectEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentProjectEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: RecentProjectEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/** Neueste zuerst. */
export function getRecentProjects(): RecentProjectEntry[] {
  return readAll();
}

/** Trägt einen Pfad als "gerade geöffnet/gespeichert" ein (an den Anfang,
 * Duplikate entfernt, auf MAX_ENTRIES gekappt). */
export function addRecentProject(path: string, name: string): void {
  const rest = readAll().filter((e) => e.path !== path);
  const next = [{ path, name, openedAt: new Date().toISOString() }, ...rest].slice(
    0,
    MAX_ENTRIES,
  );
  writeAll(next);
}

/** Entfernt einen Eintrag (z. B. wenn die Datei beim Öffnen nicht mehr existiert). */
export function removeRecentProject(path: string): void {
  writeAll(readAll().filter((e) => e.path !== path));
}
