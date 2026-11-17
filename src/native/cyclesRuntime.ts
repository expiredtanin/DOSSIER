// Mitgeliefertes Cycles ([215], Endbilder) aus der App starten — gemeinsame Fassade für Tauri (macOS) und Electron (Linux).
// Tauri: Rust-Befehle `cycles_where`, `cycles_job_dir`, `cycles_start`, `cycles_cancel` (src-tauri/src/cycles.rs), Ereignisse
// `cycles://line` / `cycles://exit`, Szenendateien über das fs-Plugin im Ordner `$TEMP/dossier-render`. Electron: `window.dossierCycles`
// (scripts/electron-preload.cjs → scripts/electron-cycles.cjs). Im reinen Browser gibt es kein Programm: `cyclesAvailable()` ist false.
//
// Ablauf eines Bildes: Szene (Cycles-XML + Texturen) mit `prepareCyclesScene` in einen Arbeitsordner schreiben, `runCycles` mit
// den Schaltern aufrufen (Pfade relativ zum Arbeitsordner), das Ergebnis mit `readCyclesFile` lesen. Der Hauptprozess startet nur das
// Programm im Paketordner und prüft die Argumente (Schalterliste, Wertebereiche, Dateien nur im Arbeitsordner).
// Die Tauri-Plugins werden nur dynamisch importiert (Muster `blender.ts`): Browser-Build und vitest brauchen sie nicht.
// Nicht auf dem Mac geprüft (Tauri-Teil nach Muster geschrieben); Electron/Linux: e2e/linuxApp170.spec.ts.

import { isTauri } from "./blender";

/** Von electron-preload.cjs injiziert (nur Electron/Linux). */
export interface DossierCyclesApi {
  where: () => Promise<string | null>;
  prepare: (files: { path: string; bytes: Uint8Array }[]) => Promise<string>;
  start: (jobId: string, sceneDir: string, args: string[]) => Promise<void>;
  cancel: (jobId: string) => void;
  readFile: (path: string) => Promise<Uint8Array>;
  onLine: (cb: (e: { jobId: string; line: string }) => void) => () => void;
  onExit: (cb: (e: { jobId: string; code: number }) => void) => () => void;
}

declare global {
  interface Window {
    dossierCycles?: DossierCyclesApi;
  }
}

/** Fortschritt aus einer Zeile `Progress 06.25   Sample 1/16` (Anteil 0…1, Sample, Samples). */
export interface CyclesProgress {
  fraction: number;
  sample: number;
  samples: number;
}

const PROGRESS_RE = /Progress\s+(\d+(?:\.\d+)?)\s+Sample\s+(\d+)\s*\/\s*(\d+)/;

/** Liest eine Ausgabezeile von Cycles; `null`, wenn sie kein Fortschritt ist („Updating …“, „Writing image …“). */
export function parseCyclesProgress(line: string): CyclesProgress | null {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const samples = Number(m[3]);
  const sample = Number(m[2]);
  const percent = Number(m[1]);
  if (!(samples > 0) || !Number.isFinite(percent)) return null;
  return { fraction: Math.min(1, Math.max(0, percent / 100)), sample, samples };
}

/** Wirt: wo liegt Cycles, Dateien schreiben/lesen, Prozess starten (Tauri und Electron liefern je eine Fassung). */
interface CyclesHost {
  where(): Promise<string | null>;
  prepare(files: { path: string; bytes: Uint8Array }[]): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  spawn(sceneDir: string, args: string[], onLine: (line: string) => void): { done: Promise<number>; cancel(): void };
}

let counter = 0;
const newJobId = (): string => `cycles-${Date.now().toString(36)}-${counter++}`;
const join = (dir: string, rel: string): string => `${dir.replace(/[\\/]+$/, "")}/${rel}`;

async function tauriHost(): Promise<CyclesHost> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const fs = await import("@tauri-apps/plugin-fs");
  return {
    where: () => invoke<string | null>("cycles_where"),
    async prepare(files) {
      const dir = await invoke<string>("cycles_job_dir");
      const made = new Set<string>();
      for (const f of files) {
        const slash = f.path.lastIndexOf("/");
        if (slash > 0) {
          const sub = join(dir, f.path.slice(0, slash));
          if (!made.has(sub)) {
            await fs.mkdir(sub, { recursive: true });
            made.add(sub);
          }
        }
        await fs.writeFile(join(dir, f.path), f.bytes);
      }
      return dir;
    },
    readFile: (path) => fs.readFile(path),
    spawn(sceneDir, args, onLine) {
      const jobId = newJobId();
      const done = (async () => {
        let resolveExit!: (code: number) => void;
        const exit = new Promise<number>((r) => (resolveExit = r));
        const offLine = await listen<{ jobId: string; line: string }>("cycles://line", (e) => {
          if (e.payload.jobId === jobId) onLine(e.payload.line);
        });
        const offExit = await listen<{ jobId: string; code: number }>("cycles://exit", (e) => {
          if (e.payload.jobId === jobId) resolveExit(e.payload.code);
        });
        try {
          await invoke("cycles_start", { jobId, sceneDir, args });
          return await exit;
        } finally {
          offLine();
          offExit();
        }
      })();
      return { done, cancel: () => void invoke("cycles_cancel", { jobId }).catch(() => undefined) };
    },
  };
}

function electronHost(api: DossierCyclesApi): CyclesHost {
  return {
    where: () => api.where(),
    prepare: (files) => api.prepare(files),
    readFile: (path) => api.readFile(path),
    spawn(sceneDir, args, onLine) {
      const jobId = newJobId();
      let resolveExit!: (code: number) => void;
      const exit = new Promise<number>((r) => (resolveExit = r));
      const offLine = api.onLine((e) => {
        if (e.jobId === jobId) onLine(e.line);
      });
      const offExit = api.onExit((e) => {
        if (e.jobId === jobId) resolveExit(e.code);
      });
      const done = api
        .start(jobId, sceneDir, args)
        .then(() => exit)
        .finally(() => {
          offLine();
          offExit();
        });
      return { done, cancel: () => api.cancel(jobId) };
    },
  };
}

async function cyclesHost(): Promise<CyclesHost | null> {
  if (typeof window === "undefined") return null;
  if (window.dossierCycles) return electronHost(window.dossierCycles);
  if (isTauri()) return tauriHost();
  return null;
}

/** Ist ein Cycles-Programm in dieser Installation vorhanden und lauffähig (nicht im Browser, nicht bei Paketen ohne Cycles)? */
export async function cyclesAvailable(): Promise<boolean> {
  try {
    const host = await cyclesHost();
    return host ? (await host.where()) !== null : false;
  } catch {
    return false;
  }
}

async function requireHost(): Promise<CyclesHost> {
  const host = await cyclesHost();
  if (!host || (await host.where()) === null) throw new Error("Cycles ist in dieser Installation nicht verfügbar");
  return host;
}

/** Schreibt Szenendateien (Pfade relativ, mit `/`) in einen neuen Arbeitsordner und gibt dessen Pfad zurück. */
export async function prepareCyclesScene(files: { path: string; bytes: Uint8Array }[]): Promise<string> {
  return (await requireHost()).prepare(files);
}

/** Liest eine Datei aus dem Arbeitsordner (z. B. das gerenderte Bild). */
export async function readCyclesFile(path: string): Promise<Uint8Array> {
  return (await requireHost()).readFile(path);
}

export interface CyclesResult {
  /** Exit-Code von Cycles; -1 nach Abbruch oder wenn der Prozess nicht startete. */
  code: number;
  cancelled: boolean;
  /** Letzte Ausgabezeilen ohne Fortschritt (für Fehlermeldungen), höchstens 200. */
  lines: string[];
}

/**
 * Startet Cycles im Arbeitsordner `sceneDir` (von {@link prepareCyclesScene}). `args`: Schalter wie `["--background", "--samples", "64",
 * "--output", "bild.png", "szene.xml"]` (Dateien relativ zum Arbeitsordner); der Hauptprozess erlaubt nur bekannte Schalter.
 * `onProgress` bekommt Anteil und `Sample n/N`. Abbruch über `signal`: beendet den Prozess, das Ergebnis hat `cancelled: true`.
 */
export async function runCycles(
  sceneDir: string,
  args: string[],
  onProgress: (p: CyclesProgress) => void,
  signal?: AbortSignal,
): Promise<CyclesResult> {
  const host = await requireHost();
  const lines: string[] = [];
  if (signal?.aborted) return { code: -1, cancelled: true, lines };
  const job = host.spawn(sceneDir, args, (line) => {
    const p = parseCyclesProgress(line);
    if (p) onProgress(p);
    else {
      lines.push(line);
      if (lines.length > 200) lines.shift();
    }
  });
  let cancelled = false;
  const abort = (): void => {
    cancelled = true;
    job.cancel();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const code = await job.done;
    return { code, cancelled, lines };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
