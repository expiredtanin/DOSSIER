// electron-main.js — Electron-Prototyp-Shell für die CAD-App.
//
// Ersetzt WebKitGTK (Tauri-Linux-Webview) durch Chromium, damit WebGPU
// (render2d-WASM-Engine, ?engine=wasm) zuverlässig läuft. Kein Rust-Backend
// nötig: compute_joins hat einen TS-Fallback (src/compute/index.ts).

const { app, BrowserWindow, Menu } = require("electron");

// Randloses App-Fenster wie chromium-shell.sh (--app=…): keine native
// Menüleiste (File/Edit/View/Window), kein Fensterrahmen.
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
    },
  });

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(require("node:path").join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
