// electron-preload.cjs — Bruecke zwischen dem isolierten Renderer (contextIsolation)
// und dem Electron-Hauptprozess. Braucht es NUR fuer die custom Fenstersteuerung
// (Minimieren/Maximieren/Schliessen) im randlosen Fenster (frame:false, siehe
// electron-main.cjs) — sonst gaebe es keine Moeglichkeit, das Fenster ueberhaupt
// zu steuern.

const { contextBridge, ipcRenderer } = require("electron");

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
});
