// Datei-Speicherung mit nativem „Speichern unter"-Dialog im Tauri-Fenster,
// im reinen Browser Fallback auf den klassischen Blob-/Anchor-Download.
//
// Wichtig: Die Tauri-Plugins werden NUR dynamisch importiert. So scheitert der
// reine Browser-Build/vitest nicht an fehlenden Tauri-Modulen und der Code laeuft
// auch ohne Tauri-Laufzeit.

/** Erkennt, ob wir im Tauri-Webview laufen (dann steht `__TAURI_INTERNALS__`). */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let warnedFallback = false;

/** Schreiben in die Zieldatei ist gescheitert ([116]); die bisherige Datei ist unverändert.
 *  Wird NICHT auf den Browser-Download zurückgefallen — der Aufrufer meldet es dem Nutzer. */
export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveError";
  }
}

/** Atomar schreiben über den Rust-Befehl `save_atomic` (Temp-Datei + fsync + Umbenennen,
 *  Vorversion als `<pfad>~`). Wirft {@link SaveError}. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_atomic", { path, content });
  } catch (err) {
    throw new SaveError(err instanceof Error ? err.message : String(err));
  }
}

/** Datei-Endungsfilter fuer den nativen Speichern-/Oeffnen-Dialog (Tauri). */
export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

/**
 * Speichert Text-Inhalt in eine Datei.
 * - Unter Tauri: nativer Save-Dialog (Ordner + Name) → `writeTextFile`.
 * - Im Browser: Blob + Anchor-Download in den Download-Ordner.
 *
 * @param filters Optionale Datei-Endungsfilter fuer den nativen Dialog (z. B.
 *        Projekt-Endung). Additiv/optional, damit bestehende Aufrufer ohne
 *        Filter unveraendert funktionieren (Default-Verhalten: irgendeine Endung).
 * @param onSavedPath Optionaler Callback mit dem gewaehlten Pfad, NUR bei
 *        erfolgreichem Tauri-Speichern (z. B. fuer die Zuletzt-geoeffnet-Liste,
 *        s. state/recentProjects.ts) — additiv, aendert den Rueckgabewert nicht.
 * @param atomic Absturzsicher schreiben ([116], `writeFileAtomic`): bei Fehler wird
 *        {@link SaveError} geworfen statt auf den Download zurückzufallen.
 * @returns `true` wenn geschrieben/geladen wurde, `false` bei Abbruch (Dialog
 *          ohne Pfad). Bei einem Tauri-Fehler wird auf den Browser-Fallback
 *          zurueckgefallen.
 */
export async function saveTextFile(
  content: string,
  defaultName: string,
  mime = "application/octet-stream",
  filters?: FileDialogFilter[],
  onSavedPath?: (path: string) => void,
  atomic = false,
): Promise<boolean> {
  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: defaultName, filters });
      if (!path) return false; // Nutzer hat abgebrochen
      if (atomic) await writeFileAtomic(path, content);
      else {
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(path, content);
      }
      onSavedPath?.(path);
      return true;
    } catch (err) {
      if (err instanceof SaveError) throw err;
      // Projektdatei ([116]): ein stiller Download-Ersatz würde als „gespeichert" gelten, obwohl am Zielort nichts liegt.
      if (atomic) throw new SaveError(err instanceof Error ? err.message : String(err));
      if (!warnedFallback) {
        warnedFallback = true;
        console.warn(
          "Nativer Speichern-Dialog fehlgeschlagen, nutze Browser-Download.",
          err,
        );
      }
      // Weiter zum Browser-Fallback unten.
    }
  }
  return browserDownload(content, defaultName, mime);
}

/**
 * Speichert Binaer-Inhalt (z. B. ein PDF) in eine Datei — gleiches Tauri-/
 * Browser-Muster wie {@link saveTextFile}, nur mit `writeFile` (Bytes) statt
 * `writeTextFile`.
 * - Unter Tauri: nativer Save-Dialog → `writeFile(path, bytes)`.
 * - Im Browser: Blob + Anchor-Download.
 *
 * @returns `true` wenn geschrieben/geladen wurde, `false` bei Abbruch.
 */
export async function saveBinaryFile(
  bytes: Uint8Array,
  defaultName: string,
  mime = "application/octet-stream",
): Promise<boolean> {
  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: defaultName });
      if (!path) return false; // Nutzer hat abgebrochen
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, bytes);
      return true;
    } catch (err) {
      if (!warnedFallback) {
        warnedFallback = true;
        console.warn(
          "Nativer Speichern-Dialog fehlgeschlagen, nutze Browser-Download.",
          err,
        );
      }
      // Weiter zum Browser-Fallback unten.
    }
  }
  return browserDownloadBlob(new Blob([bytes as BlobPart], { type: mime }), defaultName);
}

/** Klassischer Blob-/Anchor-Download (gehaertet wie der bisherige Helfer). */
function browserDownload(content: string, defaultName: string, mime: string): boolean {
  return browserDownloadBlob(new Blob([content], { type: mime }), defaultName);
}

/** Anchor-Download eines fertigen Blobs (Text wie Binaer). */
function browserDownloadBlob(blob: Blob, defaultName: string): boolean {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 4000);
  return true;
}

/** Hauptdatei samt Begleitdatei, die auf sie verweist ([201], OBJ + MTL). */
export interface TextWithCompanion {
  main: string;
  companion: string;
}

/**
 * Speichert eine Textdatei und eine Begleitdatei mit gleichem Namen, aber anderer Endung (OBJ + MTL).
 * `build` bekommt den Dateinamen der Begleitdatei (für den Verweis in der Hauptdatei, z. B. `mtllib`).
 * - Unter Tauri: Speichern-Dialog für die Hauptdatei, danach ein zweiter für die Begleitdatei (Vorschlag: gleicher Ordner und
 *   Stamm) — der Dialog gibt den Pfad frei; ein stilles Schreiben neben die Hauptdatei dürfte am Dateizugriff scheitern.
 *   Bricht man den zweiten ab, bleibt die Hauptdatei mit totem Verweis (nur die Farben fehlen dann).
 * - Im Browser: zwei Downloads nacheinander.
 *
 * @returns `true` wenn die Hauptdatei geschrieben wurde, `false` bei Abbruch.
 */
export async function saveTextWithCompanion(
  build: (companionName: string) => TextWithCompanion,
  defaultName: string,
  companionExt: string,
  filters?: FileDialogFilter[],
  companionFilters?: FileDialogFilter[],
): Promise<boolean> {
  const stemOf = (name: string) => name.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({ defaultPath: defaultName, filters });
      if (!path) return false;
      const companionName = `${stemOf(path)}.${companionExt}`;
      const files = build(companionName);
      await writeTextFile(path, files.main);
      const companionPath = await save({ defaultPath: path.replace(/[^\\/]*$/, companionName), filters: companionFilters });
      if (companionPath) await writeTextFile(companionPath, files.companion);
      return true;
    } catch (err) {
      if (!warnedFallback) {
        warnedFallback = true;
        console.warn("Nativer Speichern-Dialog fehlgeschlagen, nutze Browser-Download.", err);
      }
    }
  }
  const companionName = `${stemOf(defaultName)}.${companionExt}`;
  const files = build(companionName);
  browserDownload(files.main, defaultName, "application/octet-stream");
  return browserDownload(files.companion, companionName, "application/octet-stream");
}
