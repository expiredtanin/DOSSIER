// electron-blender.cjs — Blender als eigener Prozess im Electron-Hauptprozess ([211], Rendering mit Blender/Cycles).
// Gegenstück zu src-tauri/src/blender.rs (Tauri): suchen, Paket in einen Arbeitsordner schreiben, starten,
// Ausgabe zeilenweise melden, abbrechen. Blender ist GPL und bleibt ein fremdes Programm.
// Die Renderer-Seite ist src/native/blender.ts (`window.dossierBlender`, electron-preload.cjs).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CANDIDATES = [
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "/usr/bin/blender",
  "/usr/local/bin/blender",
  "/snap/bin/blender",
  "/var/lib/flatpak/exports/bin/org.blender.Blender",
];

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Eigene Angabe, dann `blender` im PATH, dann die üblichen Orte; null = nicht gefunden. */
function findBlender(custom) {
  const c = typeof custom === "string" ? custom.trim() : "";
  if (c) {
    if (isFile(c)) return c;
    const inner = path.join(c, "Contents", "MacOS", "Blender");
    return isFile(inner) ? inner : null;
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "blender");
    if (isFile(p)) return p;
  }
  return CANDIDATES.find(isFile) ?? null;
}

const jobs = new Map();
let jobDirs = 0;

/** Nur Pfade im eigenen Arbeitsordner lesen. */
function insideRenderDir(p) {
  const root = path.resolve(os.tmpdir(), "dossier-render") + path.sep;
  return path.resolve(p).startsWith(root);
}

/** Meldet Ausgabe in Zeilen (Ende bei \n oder \r, Blender überschreibt Fortschrittszeilen). */
function lineSplitter(onLine) {
  let rest = "";
  return {
    push(chunk) {
      rest += chunk.toString("utf8");
      const parts = rest.split(/[\r\n]+/);
      rest = parts.pop() ?? "";
      for (const p of parts) if (p) onLine(p);
    },
    end() {
      if (rest) onLine(rest);
      rest = "";
    },
  };
}

function register(ipcMain) {
  ipcMain.handle("blender:find", (_e, custom) => findBlender(custom));

  ipcMain.handle("blender:prepare", (_e, files) => {
    const dir = path.join(os.tmpdir(), "dossier-render", `${Date.now()}-${process.pid}-${jobDirs++}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const target = path.resolve(dir, f.path);
      if (!target.startsWith(dir + path.sep)) throw new Error(`Pfad ausserhalb des Arbeitsordners: ${f.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(f.bytes));
    }
    return dir;
  });

  ipcMain.handle("blender:read", (_e, p) => {
    if (!insideRenderDir(p)) throw new Error("Pfad ausserhalb des Arbeitsordners");
    return new Uint8Array(fs.readFileSync(p));
  });

  // Läuft, bis Blender endet; Zeilen und Ende gehen als Ereignisse an das Fenster, das den Auftrag stellte.
  ipcMain.handle("blender:start", (event, jobId, exe, args) => {
    if (!isFile(exe) || !/blender/i.test(path.basename(exe))) throw new Error(`keine Blender-Programmdatei: ${exe}`);
    const sender = event.sender;
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    jobs.set(jobId, child);
    const send = (channel, payload) => {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    };
    const out = lineSplitter((line) => send("blender:line", { jobId, line }));
    const err = lineSplitter((line) => send("blender:line", { jobId, line }));
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => send("blender:line", { jobId, line: `DOSSIER_ERROR ${e.message}` }));
    child.on("close", (code) => {
      out.end();
      err.end();
      jobs.delete(jobId);
      send("blender:exit", { jobId, code: code ?? -1 });
    });
  });

  ipcMain.on("blender:cancel", (_e, jobId) => {
    jobs.get(jobId)?.kill();
  });
}

module.exports = { register, findBlender, lineSplitter };
