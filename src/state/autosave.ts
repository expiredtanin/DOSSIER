// Autosave mit Wiederherstellen (lessons-bimcraft [13]): solange das Projekt ungespeicherte
// Änderungen hat, landet alle {@link AUTOSAVE_INTERVAL_MS} eine Kopie in IndexedDB
// (`projectStore.ts`; unter Tauri liegt sie im App-Datenordner der Webview, im Browser im
// Profil). Schlüssel = Dateipfad bzw. „unsaved" für ein noch nie gespeichertes Projekt.
//
// Lebenszyklus: Speichern oder bewusstes Verwerfen löscht die Kopie. Bleibt sie liegen
// (Absturz, Fenster ohne Speichern geschlossen), bietet Dossier sie beim nächsten Start bzw.
// beim Öffnen derselben Datei an: Wiederherstellen · Verwerfen · Später.

import type { Project } from "../model/types";
import { deleteProject, loadProjectRecord, saveProjectChecked } from "./projectStore";
import type { StoredProject } from "./projectStore";

export const AUTOSAVE_INTERVAL_MS = 30_000;
const PREFIX = "autosave:";
const UNSAVED = "unsaved";
const PREV_SUFFIX = "#prev";

/** Schlüssel der Wiederherstellungskopie für eine Datei (oder ein ungespeichertes Projekt). */
export const autosaveKey = (path: string | null): string => PREFIX + (path ?? UNSAVED);
/** Schlüssel der vorigen Kopie: ist die neueste beschädigt (Absturz mitten im Schreiben), bleibt diese. */
export const autosavePrevKey = (path: string | null): string => autosaveKey(path) + PREV_SUFFIX;

/** Speicher der Kopien (Standard IndexedDB, `projectStore.ts`; Tests setzen einen eigenen). */
export interface AutosaveBackend {
  read(name: string): Promise<{ project: StoredProject; savedAt: number } | null>;
  /** `false`: nicht geschrieben (Kontingent, kein IndexedDB …). */
  write(name: string, text: string, savedAt?: number): Promise<boolean>;
  remove(name: string): Promise<void>;
}

const idbBackend: AutosaveBackend = {
  read: loadProjectRecord,
  write: saveProjectChecked,
  remove: deleteProject,
};
let backend: AutosaveBackend = idbBackend;
/** Nur für Tests: anderer Speicher (`null` = IndexedDB). */
export const setAutosaveBackend = (b: AutosaveBackend | null): void => {
  backend = b ?? idbBackend;
};

const asText = (r: { project: StoredProject }): string => (typeof r.project === "string" ? r.project : JSON.stringify(r.project));

/**
 * Sichert den Datei-Text des Projekts (`serializeProject`, wie beim Speichern; [K4] S4). Zwei Stände:
 * die bisherige Kopie rückt nach `#prev`, die neue wird die aktuelle. Liefert `false`, wenn die neue
 * Kopie nicht geschrieben werden konnte (der Aufrufer meldet das und versucht es später wieder).
 */
export async function writeAutosave(path: string | null, text: string): Promise<boolean> {
  try {
    const cur = await backend.read(autosaveKey(path));
    // Schlägt das Rücken fehl (Platz), ist die neue Kopie trotzdem wichtiger.
    if (cur) await backend.write(autosavePrevKey(path), asText(cur), cur.savedAt);
    return await backend.write(autosaveKey(path), text);
  } catch {
    return false;
  }
}

/** Liest die neueste Kopie als Datei-Text (ältere Kopien als Objekt werden zu Text) — Wiederherstellen lädt sie
 *  wie eine Datei (`openProjectFile`: Migration, Prüfung). */
export const readAutosave = async (path: string | null): Promise<{ text: string; savedAt: number } | null> => {
  const r = await backend.read(autosaveKey(path));
  return r ? { text: asText(r), savedAt: r.savedAt } : null;
};

export const clearAutosave = async (path: string | null): Promise<void> => {
  await backend.remove(autosaveKey(path));
  await backend.remove(autosavePrevKey(path));
};

/**
 * Sucht die neueste LESBARE Kopie (`isValid`: z. B. Kern-Prüfung der Projektdatei). Beschädigte Kopien
 * (abgeschnittener Text nach Absturz im Schreiben) werden gelöscht und als `damaged` gemeldet; die
 * vorige Kopie springt dann ein. Wirft nie.
 */
export async function pickAutosave(
  path: string | null,
  isValid: (text: string) => boolean,
): Promise<{ found: { text: string; savedAt: number } | null; damaged: boolean }> {
  let damaged = false;
  for (const key of [autosaveKey(path), autosavePrevKey(path)]) {
    let rec: { project: StoredProject; savedAt: number } | null = null;
    try {
      rec = await backend.read(key);
    } catch {
      rec = null;
    }
    if (!rec) continue;
    const text = asText(rec);
    let ok = false;
    try {
      ok = isValid(text);
    } catch {
      ok = false;
    }
    if (ok) return { found: { text, savedAt: rec.savedAt }, damaged };
    damaged = true;
    try {
      await backend.remove(key);
    } catch {
      /* ignorieren */
    }
  }
  return { found: null, damaged };
}

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
