// electron-main.js — Electron-Prototyp-Shell für die CAD-App.
//
// Ersetzt WebKitGTK (Tauri-Linux-Webview) durch Chromium, damit WebGPU
// (render2d-WASM-Engine, ?engine=wasm) zuverlässig läuft. Kein Rust-Backend
// nötig: compute_joins hat einen TS-Fallback (src/compute/index.ts).

const { app, BrowserWindow, Menu, ipcMain, protocol, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { buildCsp } = require("./csp.cjs");
require("./electron-blender.cjs").register(ipcMain); // [211] Blender als eigener Prozess

// Randloses App-Fenster wie chromium-shell.sh (--app=…): keine native
// Menüleiste (File/Edit/View/Window), kein Fensterrahmen. Minimieren/
// Maximieren/Schliessen laufen darum über eine eigene Fenstersteuerung im
// Renderer (WindowControls.tsx) + IPC hier unten — ohne frame gibt es sonst
// gar keine Möglichkeit, das Fenster zu steuern.
Menu.setApplicationMenu(null);

// Gleiche Flags wie scripts/chromium-shell.sh — WebGPU liegt unter Linux
// hinter --enable-unsafe-webgpu, und WebGPU braucht das Vulkan-Backend.
app.commandLine.appendSwitch("enable-unsafe-webgpu");
// DOSSIER_GPU: „vulkan“ (Vorgabe, wie bisher: Skia + ANGLE über Vulkan), „angle“ (nur ANGLE über Vulkan, Skia/Compositor
// auf GL — hilft, wenn „Failed to create vulkan surface“ erscheint und das Fenster leer bleibt), „minimal“ (nur WebGPU
// freigeben, sonst Chromium-Vorgaben). Zum Ausprobieren: DOSSIER_GPU=angle dossier.
const gpu = process.env.DOSSIER_GPU || "vulkan";
if (gpu === "vulkan") app.commandLine.appendSwitch("enable-features", "Vulkan,VulkanFromANGLE,DefaultANGLEVulkan");
else if (gpu === "angle") app.commandLine.appendSwitch("enable-features", "VulkanFromANGLE,DefaultANGLEVulkan");
console.log(`[dossier] GPU-Modus: ${gpu}`);
// Unter Wayland verträgt sich Chromiums Vulkan nicht mit `--ozone-platform=wayland` („not compatible with Vulkan“,
// das Fenster geht sofort wieder zu) → über XWayland (x11) starten. Übersteuerbar: DOSSIER_OZONE=wayland|x11.
const ozone = process.env.DOSSIER_OZONE || (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland" ? "x11" : "");
if (ozone) app.commandLine.appendSwitch("ozone-platform", ozone);

const DEV_URL = "http://localhost:5187";
const isDev = !app.isPackaged && !process.env.DOSSIER_USE_DIST; // DOSSIER_USE_DIST=1: gebautes dist ohne Paket prüfen

// [170] Gepackt (AppImage/Flatpak) lädt die App aus `dist` über ein eigenes, „standard“-Schema statt
// file://: absolute Asset-Pfade (/assets/…), fetch() der WASM-Module (application/wasm), Worker und
// localStorage brauchen einen richtigen Ursprung. Muss vor `ready` registriert werden.
const APP_SCHEME = "dossier";
const APP_ORIGIN = `${APP_SCHEME}://app`;
const DIST_DIR = path.join(__dirname, "..", "dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

function serveDist(request) {
  const { pathname } = new URL(request.url);
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(DIST_DIR, rel));
  // Kein Ausbruch aus dist (../).
  if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) return new Response("Forbidden", { status: 403 });
  try {
    const body = fs.readFileSync(file);
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    return new Response(body, { headers: { "content-type": type } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// [170] Projektdatei per Argument (`dossier datei.obp`, Doppelklick im Dateimanager über %F im
// Desktop-Eintrag). Erste vorhandene .obp-Datei der Argumente; relative Pfade gegen `cwd`.
function findProjectArg(argv, cwd) {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith("-") || !/\.obp$/i.test(a)) continue;
    const full = path.resolve(cwd || process.cwd(), a);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* nicht vorhanden: ignorieren */
    }
  }
  return null;
}

let mainWindow = null;
let pendingOpenFile = findProjectArg(process.argv, process.cwd());

function readProject(file) {
  try {
    return { name: path.basename(file), path: file, text: fs.readFileSync(file, "utf8") };
  } catch {
    return null;
  }
}

// Nur eine Instanz: ein zweiter Start (`dossier b.obp`) reicht die Datei an das offene Fenster weiter.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, cwd) => {
    const file = findProjectArg(argv, cwd);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const proj = file && readProject(file);
      if (proj) mainWindow.webContents.send("launch:open-file", proj);
    } else if (file) {
      pendingOpenFile = file;
    }
  });
}

ipcMain.handle("launch:take-open-file", () => {
  const file = pendingOpenFile;
  pendingOpenFile = null;
  return file ? readProject(file) : null;
});

function createWindow() {
  const win = new BrowserWindow({
    title: "Dossier",
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

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  const notifyMaximized = () => {
    win.webContents.send("window:maximized-changed", win.isMaximized());
  };
  win.on("maximize", notifyMaximized);
  win.on("unmaximize", notifyMaximized);

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadURL(`${APP_ORIGIN}/index.html`);
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

app.whenReady().then(() => {
  if (!gotLock) return;
  // [117] CSP als Antwort-Header — nur gepackt: der Dev-Server (Vite HMR) braucht Inline-Skripte.
  if (!isDev) {
    protocol.handle(APP_SCHEME, serveDist);
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [buildCsp()] } });
    });
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
