// Projekt-Persistenz — IndexedDB (Browser-nativer Speicher-Kern).
//
// Speichert vollständige Projekte (inkl. Meshes/grosser JSON-Nutzlast) lokal
// im Browser. Analog zu visibilitySets.ts: reine Speicher-Helfer OHNE React-
// Abhängigkeit, sämtlicher Zugriff defensiv (SSR/Tests/Privatmodus) — hier
// mit `indexedDB` statt `localStorage`, da localStorage-Kontingente für
// Projekt-JSON (Wände, Meshes, …) zu klein sind.
//
// Hinweis: Dies ist nur der Speicher-KERN (CRUD-API). UI-Verdrahtung
// (Speichern/Öffnen-Menü, zuletzt-geöffnet-Liste, Auto-Save) ist NICHT Teil
// dieses Moduls — folgt als separates Item.

import type { Project } from "../model/types";

/** Name der IndexedDB-Datenbank. */
const DB_NAME = "dossier";
/** Name des ObjectStores (keyPath „name"). */
const STORE_NAME = "projects";
/** DB-Schemaversion. */
const DB_VERSION = 1;

/** Ein gespeicherter Datensatz je Projekt. */
interface ProjectRecord {
  name: string;
  savedAt: number;
  /** Projekt als Objekt oder als Datei-Text (Autosave, `serializeProject`). */
  project: StoredProject;
}

/** Gespeicherter Inhalt: Projekt-Objekt oder Datei-Text. */
export type StoredProject = Project | string;

/** `true`, sobald die Fehlmeldung „IndexedDB nicht verfügbar" geloggt wurde (nur einmal). */
let warnedUnavailable = false;

/** Warnt einmalig auf der Konsole, dass IndexedDB fehlt (Tests/SSR/Privatmodus). */
function warnUnavailableOnce(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  try {
    // eslint-disable-next-line no-console
    console.warn(
      "[projectStore] IndexedDB nicht verfügbar — Projekt-Persistenz deaktiviert.",
    );
  } catch {
    // Konsole kann in exotischen Umgebungen fehlen — ignorieren.
  }
}

/** Liefert `true`, wenn `indexedDB` in dieser Umgebung nutzbar ist. */
function isAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    // Zugriff kann werfen (z. B. strikte SSR-Sandboxen).
    return false;
  }
}

/** Gecachtes Öffnen-Promise, damit `indexedDB.open` nur einmal läuft. */
let dbPromise: Promise<IDBDatabase> | null = null;

/** Öffnet (bzw. erstellt) die Datenbank und liefert die geöffnete Verbindung. */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "name" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB.open fehlgeschlagen"));
  });
  // Bei Fehlschlag den Cache zurücksetzen, damit ein späterer Aufruf erneut
  // versuchen kann (statt dauerhaft am fehlgeschlagenen Promise zu hängen).
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/**
 * Speichert ein Projekt unter `name` (überschreibt einen vorhandenen
 * Datensatz gleichen Namens). Ohne IndexedDB: no-op (wirft nicht).
 */
export async function saveProject(name: string, project: StoredProject): Promise<void> {
  if (!name) return;
  if (!isAvailable()) {
    warnUnavailableOnce();
    return;
  }
  try {
    const db = await openDb();
    const record: ProjectRecord = { name, savedAt: Date.now(), project };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Transaktion fehlgeschlagen"));
      tx.onabort = () => reject(tx.error ?? new Error("Transaktion abgebrochen"));
    });
  } catch {
    // Kontingent überschritten, Zugriff verweigert o. Ä. — still ignorieren
    // (analog writeJson in visibilitySets.ts).
  }
}

/**
 * Lädt ein Projekt nach Namen. Liefert `null`, wenn es nicht existiert, die
 * Umgebung IndexedDB nicht unterstützt oder der Zugriff fehlschlägt.
 */
export async function loadProject(name: string): Promise<StoredProject | null> {
  if (!name) return null;
  if (!isAvailable()) {
    warnUnavailableOnce();
    return null;
  }
  try {
    const db = await openDb();
    const record = await new Promise<ProjectRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(name);
      request.onsuccess = () => resolve(request.result as ProjectRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error("Lesen fehlgeschlagen"));
    });
    return record?.project ?? null;
  } catch {
    return null;
  }
}

/** Wie {@link loadProject}, mit Speicherzeitpunkt (ms seit Epoche). */
export async function loadProjectRecord(name: string): Promise<{ project: StoredProject; savedAt: number } | null> {
  if (!name || !isAvailable()) return null;
  try {
    const db = await openDb();
    const record = await new Promise<ProjectRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(name);
      request.onsuccess = () => resolve(request.result as ProjectRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error("Lesen fehlgeschlagen"));
    });
    return record ? { project: record.project, savedAt: record.savedAt } : null;
  } catch {
    return null;
  }
}

/**
 * Listet alle gespeicherten Projekte (Name + Speicherzeitpunkt), alphabetisch
 * nach Name sortiert. Ohne IndexedDB oder bei Fehler: leere Liste.
 */
export async function listProjects(): Promise<{ name: string; savedAt: number }[]> {
  if (!isAvailable()) {
    warnUnavailableOnce();
    return [];
  }
  try {
    const db = await openDb();
    const records = await new Promise<ProjectRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result as ProjectRecord[]) ?? []);
      request.onerror = () => reject(request.error ?? new Error("Lesen fehlgeschlagen"));
    });
    return records
      .map((r) => ({ name: r.name, savedAt: r.savedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Löscht ein gespeichertes Projekt. Ohne IndexedDB oder bei Fehler: no-op
 * (wirft nicht).
 */
export async function deleteProject(name: string): Promise<void> {
  if (!name) return;
  if (!isAvailable()) {
    warnUnavailableOnce();
    return;
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Transaktion fehlgeschlagen"));
      tx.onabort = () => reject(tx.error ?? new Error("Transaktion abgebrochen"));
    });
  } catch {
    // still ignorieren — analog removeKey in visibilitySets.ts.
  }
}
