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

export const writeAutosave = (path: string | null, project: Project): Promise<void> =>
  saveProject(autosaveKey(path), project);

export const readAutosave = (path: string | null): Promise<{ project: Project; savedAt: number } | null> =>
  loadProjectRecord(autosaveKey(path));

export const clearAutosave = (path: string | null): Promise<void> => deleteProject(autosaveKey(path));

/** Eine angebotene Wiederherstellung. */
export interface AutosaveRecovery {
  path: string | null;
  project: Project;
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
