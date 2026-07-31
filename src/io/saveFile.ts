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
): Promise<boolean> {
  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: defaultName, filters });
      if (!path) return false; // Nutzer hat abgebrochen
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, content);
      onSavedPath?.(path);
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
