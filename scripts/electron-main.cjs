// electron-main.js — Electron-Prototyp-Shell für die CAD-App.
//
// Ersetzt WebKitGTK (Tauri-Linux-Webview) durch Chromium, damit WebGPU
// (render2d-WASM-Engine, ?engine=wasm) zuverlässig läuft. Kein Rust-Backend
// nötig: compute_joins hat einen TS-Fallback (src/compute/index.ts).

const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const path = require("node:path");

// Randloses App-Fenster wie chromium-shell.sh (--app=…): keine native
// Menüleiste (File/Edit/View/Window), kein Fensterrahmen. Minimieren/
// Maximieren/Schliessen laufen darum über eine eigene Fenstersteuerung im
// Renderer (WindowControls.tsx) + IPC hier unten — ohne frame gibt es sonst
// gar keine Möglichkeit, das Fenster zu steuern.
Menu.setApplicationMenu(null);

// Gleiche Flags wie scripts/chromium-shell.sh — WebGPU liegt unter Linux
// hinter --enable-unsafe-webgpu, und WebGPU braucht das Vulkan-Backend.
app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("enable-features", "Vulkan");

const DEV_URL = "http://localhost:5187";
const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "electron-preload.cjs"),
    },
  });

  const notifyMaximized = () => {
    win.webContents.send("window:maximized-changed", win.isMaximized());
  };
  win.on("maximize", notifyMaximized);
  win.on("unmaximize", notifyMaximized);

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(require("node:path").join(__dirname, "..", "dist", "index.html"));
  }
}

// Fenstersteuerung vom Renderer (WindowControls.tsx über electron-preload.cjs).
// Wirkt auf das Fenster, aus dem das Event kam (mehrfachfenster-sicher).
ipcMain.on("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on("window:toggle-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("window:is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
