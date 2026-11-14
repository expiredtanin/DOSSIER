// electron-files.cjs — Projektdateien im Electron-Hauptprozess ([116]): atomar schreiben (Temp-Datei + fsync + Umbenennen,
// Vorversion als `<pfad>~`), „Speichern unter" mit Dialog, Sicherung erkennen/lesen. Gegenstück zu src-tauri/src/atomic_save.rs
// (Tauri). Renderer-Seite: src/native/projectFile.ts (`window.dossierFiles`, electron-preload.cjs).

const fs = require("node:fs");
const path = require("node:path");

/** Schreibt `text` atomar nach `file`; mit `keepBackup` landet die Vorversion in `<file>~`. Wirft bei Fehler, das Ziel bleibt heil. */
function writeAtomic(file, text, keepBackup) {
  const tmp = `${file}.tmp`;
  const backup = `${file}~`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Kopie statt Umbenennen: der Zielpfad existiert so zu jedem Zeitpunkt.
    if (keepBackup && fs.existsSync(file)) fs.copyFileSync(file, backup);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignorieren */
    }
    throw err;
  }
  try {
    const dir = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    /* Ordner-Sync ist best effort (Windows) */
  }
}

const backupExists = (file) => {
  try {
    return fs.statSync(`${file}~`).isFile();
  } catch {
    return false;
  }
};

/** Meldet die IPC-Kanäle an. `getWindow()` liefert das Hauptfenster (Elternfenster der Dialoge). */
function register(ipcMain, dialog, getWindow) {
  ipcMain.handle("file:save-atomic", (_e, file, text) => {
    if (typeof file !== "string" || !file || typeof text !== "string") throw new Error("Ungültiger Aufruf");
    writeAtomic(file, text, true);
    return true;
  });
  // „Speichern unter": Dialog, dann atomar schreiben; null = abgebrochen.
  ipcMain.handle("file:save-as", async (_e, defaultName, text, filters) => {
    if (typeof text !== "string") throw new Error("Ungültiger Aufruf");
    const win = getWindow();
    const opts = { defaultPath: String(defaultName || "projekt.obp"), filters: Array.isArray(filters) ? filters : undefined };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    writeAtomic(r.filePath, text, true);
    return r.filePath;
  });
  ipcMain.handle("file:backup-exists", (_e, file) => typeof file === "string" && backupExists(file));
  ipcMain.handle("file:read-backup", (_e, file) => {
    if (typeof file !== "string" || !backupExists(file)) return null;
    return fs.readFileSync(`${file}~`, "utf8");
  });
}

module.exports = { register, writeAtomic, backupExists };
