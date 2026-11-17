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
  const root = renderRoot() + path.sep;
  return path.resolve(p).startsWith(root);
}

/** Legt einen Arbeitsordner an und schreibt die Dateien hinein (Pfade relativ, nicht aus dem Ordner heraus); gibt den Ordner zurück. [215] auch für Cycles. */
function prepareJobDir(files) {
  const dir = path.join(renderRoot(), `${Date.now()}-${process.pid}-${jobDirs++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const target = path.resolve(dir, f.path);
    if (!target.startsWith(dir + path.sep)) throw new Error(`Pfad ausserhalb des Arbeitsordners: ${f.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(f.bytes));
  }
  return dir;
}

/** [273] Wurzel aller Arbeitsordner (Blender und Cycles). */
function renderRoot() {
  return path.resolve(os.tmpdir(), "dossier-render");
}

/** [273] Arbeitsordner samt Inhalt löschen: nur direkt unter `$TMP/dossier-render/`, nie die Wurzel selbst; fehlender Ordner ist kein Fehler. */
function removeJobDir(p) {
  const root = renderRoot();
  const abs = typeof p === "string" && p ? path.resolve(p) : "";
  if (!abs.startsWith(root + path.sep) || path.dirname(abs) !== root) throw new Error("Pfad ist kein Arbeitsordner");
  fs.rmSync(abs, { recursive: true, force: true });
}

/** [273] Alte Arbeitsordner (Änderungszeit älter als `maxAgeMs`) direkt unter `root` löschen, z. B. nach Absturz übrig geblieben. Gibt die Zahl gelöschter Ordner zurück. */
function sweepOldJobDirs(root, maxAgeMs, now = Date.now()) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const p = path.join(root, name);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // gerade verschwunden oder gesperrt: beim nächsten Start wieder
    }
  }
  return removed;
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

  ipcMain.handle("blender:prepare", (_e, files) => prepareJobDir(files));

  // [273] Arbeitsordner nach dem Lauf löschen (Erfolg und Fehler).
  ipcMain.handle("blender:cleanup", (_e, p) => removeJobDir(p));

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

  // [228] Blender mit Oberfläche (z. B. auf eine .blend-Datei): eigener, abgelöster Prozess, kein Warten. Nur Programme namens Blender.
  ipcMain.handle("blender:open", (_e, exe, args) => {
    if (!isFile(exe) || !/blender/i.test(path.basename(exe))) throw new Error(`keine Blender-Programmdatei: ${exe}`);
    return new Promise((resolve, reject) => {
      const child = spawn(exe, Array.isArray(args) ? args.map(String) : [], { detached: true, stdio: "ignore" });
      child.once("error", (e) => reject(new Error(`Blender lässt sich nicht starten: ${e.message}`)));
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  });

  ipcMain.on("blender:cancel", (_e, jobId) => {
    jobs.get(jobId)?.kill();
  });
}

module.exports = { register, findBlender, lineSplitter, prepareJobDir, insideRenderDir, renderRoot, removeJobDir, sweepOldJobDirs };
