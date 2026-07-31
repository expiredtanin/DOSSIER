// Eigenes Projektdatei-Format (Endung `.obp`, "openbureau project") + Lock-Datei
// gegen gleichzeitiges Öffnen derselben Projektdatei aus zwei Instanzen.
//
// Der Dateiinhalt ist unverändert das bisherige Projekt-JSON — nur Endung/
// Dialog-Filter sind neu. Alte `.json`-Projekte bleiben ladbar (Filter erlaubt
// beide, s. PROJECT_DIALOG_FILTERS).
//
// Der Lock ist ein OS-Advisory-Lock im Rust-Kern (src-tauri/src/lock.rs, Crate
// `fs4`): eine Sidecar-Datei `foo.obp.lock` wird exklusiv gelockt, solange die
// Instanz die Datei offen hat. Der OS-Lock fällt beim Prozessende (auch bei
// Absturz) automatisch weg — hier nur "best effort" für sauberes Timing beim
// normalen Schliessen. Nur unter Tauri relevant: im reinen Browser gibt es
// keinen echten Dateipfad (Blob-Download), daher entfällt der Lock dort.

import { saveTextFile } from "./saveFile";

/** Datei-Endung für Projektdateien (ohne Punkt). Einzige Änderungsstelle. */
export const PROJECT_EXT = "obp";

/** Dialog-Filter für den nativen Speichern-/Öffnen-Dialog: neue Endung + Alt-JSON. */
export const PROJECT_DIALOG_FILTERS = [
  { name: "openbureau-Projekt", extensions: [PROJECT_EXT] },
  { name: "openbureau-Projekt (alt, JSON)", extensions: ["json"] },
];

/** Erkennt Tauri wie an anderen Stellen (saveFile.ts, nativeSync.ts). */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Ergebnis eines erfolgreichen nativen Öffnen-Vorgangs. */
export interface OpenedProjectFile {
  path: string;
  content: string;
}

/**
 * Öffnet eine Projektdatei über den NATIVEN Öffnen-Dialog (Filter: `.obp` +
 * `.json`). Nur unter Tauri sinnvoll — liefert `null` im Browser, dort greift
 * weiterhin der bestehende `<input type=file>`-Fluss (FileReader).
 *
 * @returns `null` bei Abbruch/ohne Tauri, sonst Pfad + Textinhalt.
 */
export async function openProjectFileNative(): Promise<OpenedProjectFile | null> {
  if (!isTauriRuntime()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: false,
    filters: PROJECT_DIALOG_FILTERS,
  });
  if (!selected || Array.isArray(selected)) return null; // Abbruch (oder Mehrfachauswahl, sollte hier nicht vorkommen)
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  const content = await readTextFile(selected);
  return { path: selected, content };
}

/**
 * Öffnet eine Projektdatei über einen BEKANNTEN Pfad (kein Dialog) — für den
 * Startbildschirm/„Zuletzt geöffnet" (state/recentProjects.ts): der Pfad kommt
 * dort schon aus einem früheren Öffnen/Speichern. Nur unter Tauri sinnvoll.
 *
 * @returns `null` ohne Tauri oder wenn die Datei nicht mehr lesbar ist (z. B.
 * gelöscht/verschoben) — der Aufrufer sollte den Eintrag dann aus der
 * Zuletzt-geöffnet-Liste entfernen.
 */
export async function openProjectFileAtPath(path: string): Promise<OpenedProjectFile | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const content = await readTextFile(path);
    return { path, content };
  } catch {
    return null;
  }
}

/**
 * Speichert das Projekt-JSON in eine `.obp`-Datei. Unter Tauri nativer
 * Speichern-Dialog mit Projekt-Filter, im Browser Blob-Download — beides via
 * {@link saveTextFile} (dort steckt die WKWebView-Härtung).
 *
 * @param json Fertig serialisiertes Projekt (JSON.stringify des ProjectSlice).
 * @param projectName `project.name` für den Standard-Dateinamen (Fallback "projekt").
 * @param onSavedPath Optionaler Callback mit dem gewählten Pfad (Zuletzt-
 *        geöffnet-Liste, s. state/recentProjects.ts).
 */
export async function saveProjectFile(
  json: string,
  projectName: string,
  onSavedPath?: (path: string) => void,
): Promise<boolean> {
  const filename = `${projectName || "projekt"}.${PROJECT_EXT}`;
  return saveTextFile(json, filename, "application/json", PROJECT_DIALOG_FILTERS, onSavedPath);
}

// ── Lock gegen Doppelöffnung (nur Tauri) ────────────────────────────────────

/** Info-Block aus der Lock-Sidecar-Datei — für die Konflikt-Meldung an den Nutzer. */
export interface LockInfo {
  pid: number;
  hostname: string;
  timestamp: string;
}

export type LockResult = { ok: true } | { ok: false; info: LockInfo | null };

/**
 * Holt (ungeguardet) die Tauri-`invoke`-Funktion, oder `null` ohne Tauri-Core.
 * Anders als das Muster in compute/index.ts bzw. plan/nativeSync.ts schluckt
 * dieser Helfer KEINE Fehler aus dem eigentlichen Aufruf — ein `Err(...)` vom
 * Rust-Command (hier: „schon gelockt", inkl. {@link LockInfo}-Payload) muss bis
 * zum Aufrufer durchgereicht werden.
 */
async function tauriInvokeFn(): Promise<
  ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null
> {
  try {
    // @ts-ignore optionales Paket
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core").catch(() => null);
    if (!mod || typeof (mod as any).invoke !== "function") return null;
    return (mod as any).invoke;
  } catch {
    return null;
  }
}

/**
 * Fordert den exklusiven Lock für `path` an (Rust-Command `acquire_project_lock`,
 * legt `path + ".lock"` an und hält einen fs4-OS-Lock darauf). Im Browser (kein
 * Tauri) sofort `{ok:true}` — dort gibt es keinen echten Pfad, also keinen Lock.
 */
export async function acquireProjectLock(path: string): Promise<LockResult> {
  if (!isTauriRuntime()) return { ok: true };
  const invoke = await tauriInvokeFn();
  if (!invoke) return { ok: true }; // Tauri-Core nicht verfügbar -> nicht blockieren
  try {
    await invoke("acquire_project_lock", { path });
    return { ok: true };
  } catch (err) {
    return { ok: false, info: isLockInfo(err) ? err : null };
  }
}

/** Gibt den Lock für `path` frei (Rust-Command `release_project_lock`). No-op ohne Tauri. */
export async function releaseProjectLock(path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvokeFn();
  if (!invoke) return;
  try {
    await invoke("release_project_lock", { path });
  } catch {
    // Freigabe ist best effort — der OS-Lock fällt beim Prozessende ohnehin weg.
  }
}

function isLockInfo(v: unknown): v is LockInfo {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as LockInfo).pid === "number" &&
    typeof (v as LockInfo).hostname === "string"
  );
}

/**
 * Best-effort Freigabe beim Schliessen des Fensters (sauberes Timing): der
 * OS-Lock fällt beim Prozessende/Absturz ohnehin automatisch weg (fs4-Handle
 * schliesst mit dem Prozess) — dieser Hook sorgt nur dafür, dass ein normales
 * Schliessen die Lock-Datei nicht unnötig bis zum nächsten GC/Poll blockiert.
 * No-op ohne Tauri.
 */
export function registerLockAutoRelease(getPath: () => string | null): void {
  if (!isTauriRuntime()) return;
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.onCloseRequested(() => {
        const path = getPath();
        if (path) void releaseProjectLock(path);
      });
    } catch {
      // Tauri-window-API nicht verfügbar -> ignorieren, OS-Lock greift ohnehin.
    }
  })();
}
