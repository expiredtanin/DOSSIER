// Autosave mit Wiederherstellen (lessons-bimcraft [13]): solange das Projekt ungespeicherte
// Änderungen hat, landet alle {@link AUTOSAVE_INTERVAL_MS} eine Kopie in IndexedDB
// (`projectStore.ts`; unter Tauri liegt sie im App-Datenordner der Webview, im Browser im
// Profil). Schlüssel = Dateipfad bzw. „unsaved" für ein noch nie gespeichertes Projekt.
//
// Lebenszyklus: Speichern oder bewusstes Verwerfen löscht die Kopie. Bleibt sie liegen
// (Absturz, Fenster ohne Speichern geschlossen), bietet Dossier sie beim nächsten Start bzw.
// beim Öffnen derselben Datei an: Wiederherstellen · Verwerfen · Später.

import type { Project } from "../model/types";
import { deleteProject, loadProjectRecord, saveProject } from "./projectStore";

export const AUTOSAVE_INTERVAL_MS = 30_000;
const PREFIX = "autosave:";
const UNSAVED = "unsaved";

/** Schlüssel der Wiederherstellungskopie für eine Datei (oder ein ungespeichertes Projekt). */
export const autosaveKey = (path: string | null): string => PREFIX + (path ?? UNSAVED);

/** Sichert den Datei-Text des Projekts (`serializeProject`, wie beim Speichern; [K4] S4). */
export const writeAutosave = (path: string | null, text: string): Promise<void> =>
  saveProject(autosaveKey(path), text);

/** Liest die Kopie als Datei-Text (ältere Kopien als Objekt werden zu Text) — Wiederherstellen lädt sie
 *  wie eine Datei (`openProjectFile`: Migration, Prüfung). */
export const readAutosave = async (path: string | null): Promise<{ text: string; savedAt: number } | null> => {
  const r = await loadProjectRecord(autosaveKey(path));
  if (!r) return null;
  return { text: typeof r.project === "string" ? r.project : JSON.stringify(r.project), savedAt: r.savedAt };
};

export const clearAutosave = (path: string | null): Promise<void> => deleteProject(autosaveKey(path));

/** Eine angebotene Wiederherstellung. */
export interface AutosaveRecovery {
  path: string | null;
  /** Datei-Text der Kopie. */
  text: string;
  savedAt: number;
}

/** Ob ein Projekt überhaupt etwas Sicherungswürdiges enthält (leere Projekte nicht sichern). */
export function hasContent(p: Project): boolean {
  return (
    p.walls.length > 0 ||
    p.drawings2d.length > 0 ||
    (p.openings?.length ?? 0) > 0 ||
    (p.ceilings?.length ?? 0) > 0 ||
    (p.roofs?.length ?? 0) > 0 ||
    (p.stairs?.length ?? 0) > 0 ||
    (p.rooms?.length ?? 0) > 0 ||
    (p.columns?.length ?? 0) > 0 ||
    (p.extrudedSolids?.length ?? 0) > 0 ||
    (p.context?.length ?? 0) > 0
  );
}

/**
 * Merkt sich, welcher Stand zuletzt gesichert wurde, und entscheidet je Intervall, ob geschrieben
 * wird. Nach dem Löschen der Kopie (Speichern, Verwerfen) MUSS `cleared()` laufen: sonst bliebe
 * ein Stand, der während des Speicherns entstand und schon einmal gesichert war, ungeschützt
 * (gespeichert wurde der ältere Stand, die Kopie ist weg, und „schon gesichert" verhinderte das
 * erneute Schreiben).
 */
export function createAutosaveTracker() {
  let lastWritten: Project | null = null;
  return {
    shouldWrite(current: Project, lastSaved: Project | null): boolean {
      if (current === lastSaved || current === lastWritten || !hasContent(current)) return false;
      lastWritten = current;
      return true;
    },
    cleared(): void {
      lastWritten = null;
    },
  };
}
