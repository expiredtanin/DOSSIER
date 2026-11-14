// electron-preload.cjs — Bruecke zwischen dem isolierten Renderer (contextIsolation)
// und dem Electron-Hauptprozess. Braucht es NUR fuer die custom Fenstersteuerung
// (Minimieren/Maximieren/Schliessen) im randlosen Fenster (frame:false, siehe
// electron-main.cjs) — sonst gaebe es keine Moeglichkeit, das Fenster ueberhaupt
// zu steuern.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("dossierWindow", {
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizedChange: (callback) => {
    const listener = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on("window:maximized-changed", listener);
    return () => ipcRenderer.removeListener("window:maximized-changed", listener);
  },
  // [116] Schliess-Wächter: bei ungespeicherten Änderungen fragt die Oberfläche (Overlay) nach, statt dass das Fenster zugeht.
  setCloseGuard: (enabled) => ipcRenderer.send("window:set-close-guard", !!enabled),
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("window:close-requested", listener);
    return () => ipcRenderer.removeListener("window:close-requested", listener);
  },
  forceClose: () => ipcRenderer.send("window:force-close"),
});

// [211] Rendering mit Blender: Prozess im Hauptprozess (electron-blender.cjs), Renderer-Seite src/native/blender.ts.
contextBridge.exposeInMainWorld("dossierBlender", {
  find: (custom) => ipcRenderer.invoke("blender:find", custom),
  prepare: (files) => ipcRenderer.invoke("blender:prepare", files),
  start: (jobId, exe, args) => ipcRenderer.invoke("blender:start", jobId, exe, args),
  cancel: (jobId) => ipcRenderer.send("blender:cancel", jobId),
  readFile: (path) => ipcRenderer.invoke("blender:read", path),
  open: (exe, args) => ipcRenderer.invoke("blender:open", exe, args),
  onLine: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("blender:line", listener);
    return () => ipcRenderer.removeListener("blender:line", listener);
  },
  onExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("blender:exit", listener);
    return () => ipcRenderer.removeListener("blender:exit", listener);
  },
});

// [170] Projektdatei, mit der die App gestartet wurde (`dossier datei.obp`), und spätere Aufrufe
// einer zweiten Instanz. Inhalt wird im Hauptprozess gelesen: {name, path, text} oder null.
contextBridge.exposeInMainWorld("dossierLaunch", {
  takeOpenFile: () => ipcRenderer.invoke("launch:take-open-file"),
  onOpenFile: (callback) => {
    const listener = (_event, file) => callback(file);
    ipcRenderer.on("launch:open-file", listener);
    return () => ipcRenderer.removeListener("launch:open-file", listener);
  },
});

// [116] Projektdateien: atomar speichern (Temp + Umbenennen, Vorversion als `~`), „Speichern unter", Sicherung lesen.
// Renderer-Seite: src/native/projectFile.ts. `pathForFile` liefert den Pfad einer im Dialog gewählten Datei.
contextBridge.exposeInMainWorld("dossierFiles", {
  saveAtomic: (path, text) => ipcRenderer.invoke("file:save-atomic", path, text),
  saveAs: (defaultName, text, filters) => ipcRenderer.invoke("file:save-as", defaultName, text, filters),
  backupExists: (path) => ipcRenderer.invoke("file:backup-exists", path),
  readBackup: (path) => ipcRenderer.invoke("file:read-backup", path),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
});
