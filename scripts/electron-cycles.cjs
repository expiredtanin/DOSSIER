// electron-cycles.cjs — das mitgelieferte Cycles als eigener Prozess im Electron-Hauptprozess ([215], Endbilder).
// Gegenstück zu src-tauri/src/cycles.rs (Tauri). Die Renderer-Seite ist src/native/cyclesRuntime.ts (`window.dossierCycles`,
// electron-preload.cjs). Sicherheit: gestartet wird NUR das Programm aus dem Paketordner (`resources/cycles/cycles`), ohne Shell,
// mit geprüften Argumenten (feste Schalter mit Wertebereich; Dateien nur im Arbeitsordner `$TMP/dossier-render/…`).
// Cycles ist Apache-2.0; Herkunft und Lizenzen: NOTICE, resources/cycles/licenses/.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { lineSplitter, prepareJobDir, insideRenderDir } = require("./electron-blender.cjs");

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const isExecutable = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return isFile(p);
  } catch {
    return false;
  }
};

/**
 * Ordner des Cycles-Pakets. Gepackt: `<resources>/cycles`. Ungepackt (Entwicklung): `DOSSIER_CYCLES_DIR` oder `build/cycles`
 * im Repository (ausgepackt von scripts/cycles/get.sh). Im gepackten Programm gibt es KEINE Umgebungsvariable zum Umlenken.
 */
function cyclesDir({ isPackaged, resourcesPath, env = process.env, repoRoot = path.join(__dirname, "..") }) {
  if (isPackaged) return path.join(resourcesPath, "cycles");
  return env.DOSSIER_CYCLES_DIR ? path.resolve(env.DOSSIER_CYCLES_DIR) : path.join(repoRoot, "build", "cycles");
}

/** Programmdatei im Paketordner oder null (fehlt / nicht ausführbar). Intel-Macs: das Paket ist arm64. */
function cyclesExe(dir, { platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin" && arch !== "arm64") return null;
  const exe = path.join(dir, "cycles");
  return isExecutable(exe) ? exe : null;
}

const INT = (min, max) => (v) => /^\d{1,6}$/.test(v) && Number(v) >= min && Number(v) <= max;
/** Schalter mit Wert, den Cycles kennt. `path`-Werte sind Dateien im Arbeitsordner. */
const VALUE_FLAGS = {
  "--samples": INT(1, 100000),
  "--width": INT(1, 16384),
  "--height": INT(1, 16384),
  "--tile-size": INT(8, 8192),
  "--threads": INT(0, 512),
  "--device": (v) => /^[A-Za-z0-9_]{1,24}(\+[A-Za-z0-9_]{1,24}){0,3}$/.test(v),
  "--log-level": (v) => ["fatal", "error", "warning", "info", "stats", "debug"].includes(v),
  "--output": "path",
};
const BOOL_FLAGS = new Set(["--background", "--quiet"]);

/** Datei im Arbeitsordner: relativ zu `sceneDir` oder absolut darin; keine Verzeichnisse ausserhalb. */
function insideDir(sceneDir, p) {
  const root = path.resolve(sceneDir);
  const abs = path.resolve(root, p);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * Prüft die Kommandozeile für Cycles. `sceneDir`: Arbeitsordner (muss in `$TMP/dossier-render` liegen). Erlaubt sind nur die Schalter
 * oben und genau EINE Szenendatei `*.xml` (Pfade relativ zum Arbeitsordner). Gibt die Argumente mit aufgelösten Pfaden zurück
 * oder wirft einen Fehler mit Begründung.
 */
function validateCyclesArgs(sceneDir, args) {
  if (typeof sceneDir !== "string" || !insideRenderDir(sceneDir)) throw new Error("Arbeitsordner liegt nicht in dossier-render");
  if (!Array.isArray(args) || args.length > 40 || args.some((a) => typeof a !== "string" || a.length > 4096 || a.includes("\0"))) {
    throw new Error("ungültige Argumente");
  }
  const out = [];
  let scene = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (BOOL_FLAGS.has(a)) {
      out.push(a);
    } else if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, a)) {
      const v = args[++i];
      if (typeof v !== "string") throw new Error(`${a}: Wert fehlt`);
      const rule = VALUE_FLAGS[a];
      if (rule === "path") {
        const abs = insideDir(sceneDir, v);
        if (!abs || !/\.(png|exr|jpe?g|tiff?)$/i.test(abs)) throw new Error(`${a}: Datei ausserhalb des Arbeitsordners oder unbekannte Endung: ${v}`);
        out.push(a, abs);
      } else {
        if (!rule(v)) throw new Error(`${a}: ungültiger Wert: ${v}`);
        out.push(a, v);
      }
    } else if (!a.startsWith("-")) {
      const abs = insideDir(sceneDir, a);
      if (!abs || !/\.xml$/i.test(abs)) throw new Error(`Szenendatei ausserhalb des Arbeitsordners oder keine .xml: ${a}`);
      if (scene) throw new Error("mehr als eine Szenendatei");
      scene = abs;
      out.push(abs);
    } else {
      throw new Error(`Schalter nicht erlaubt: ${a}`);
    }
  }
  if (!scene) throw new Error("Szenendatei fehlt");
  return out;
}

const jobs = new Map();

function register(ipcMain, app) {
  const dir = () => cyclesDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const exe = () => cyclesExe(dir());

  ipcMain.handle("cycles:where", () => exe());
  ipcMain.handle("cycles:prepare", (_e, files) => prepareJobDir(files));
  ipcMain.handle("cycles:read", (_e, p) => {
    if (!insideRenderDir(p)) throw new Error("Pfad ausserhalb des Arbeitsordners");
    return new Uint8Array(fs.readFileSync(p));
  });

  // Läuft, bis Cycles endet; Zeilen und Ende gehen als Ereignisse an das Fenster, das den Auftrag stellte.
  ipcMain.handle("cycles:start", (event, jobId, sceneDir, args) => {
    if (typeof jobId !== "string" || !/^[\w.-]{1,80}$/.test(jobId)) throw new Error("ungültige Auftragskennung");
    if (jobs.has(jobId)) throw new Error("Auftrag läuft schon");
    const program = exe();
    if (!program) throw new Error("Cycles ist in dieser Installation nicht enthalten");
    const argv = validateCyclesArgs(sceneDir, args);
    const env = { ...process.env };
    // Metal-Kernel-Quellen (macOS) liegen im Paket; Cycles liest sie über diese Variable (src/util/path.cpp).
    const source = path.join(dir(), "source");
    if (fs.existsSync(source)) env.CYCLES_KERNEL_PATH = source;
    const sender = event.sender;
    const child = spawn(program, argv, { cwd: path.resolve(sceneDir), env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    jobs.set(jobId, child);
    const send = (channel, payload) => {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    };
    // Fortschritt kommt mit \r (Cycles überschreibt die Zeile): lineSplitter trennt bei \r und \n.
    const out = lineSplitter((line) => send("cycles:line", { jobId, line }));
    const err = lineSplitter((line) => send("cycles:line", { jobId, line }));
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => send("cycles:line", { jobId, line: `DOSSIER_ERROR ${e.message}` }));
    child.on("close", (code) => {
      out.end();
      err.end();
      jobs.delete(jobId);
      send("cycles:exit", { jobId, code: code ?? -1 });
    });
  });

  ipcMain.on("cycles:cancel", (_e, jobId) => {
    jobs.get(jobId)?.kill();
  });

  process.on("exit", () => {
    for (const c of jobs.values()) c.kill();
  });
}

module.exports = { register, cyclesDir, cyclesExe, validateCyclesArgs };
