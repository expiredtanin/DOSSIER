// Lader des Rust-Kerns (`src-tauri/core` → `src/engine/pkgCore`). Der Kern wird EINMAL geladen —
// App: `initCore()` vor dem ersten Render (main.tsx), CLI: `initCore()` mit Byte-Provider
// (wasmSource.ts), Tests: `initCoreSync()` in der Vitest-Setup-Datei — und danach synchron über
// `core()` aufgerufen, passend zu den synchronen Aufrufern im TS-Kern.
//
// Wiederanlauf nach einem Panic ([118]): wasm32 kennt kein catch_unwind — ein Rust-Panic endet als
// Trap (`WebAssembly.RuntimeError: unreachable`), danach ist die Instanz unbrauchbar (geborgte
// RefCells, verwaister Zustand). `core()` liefert deshalb Hüllen um die Exporte: fängt eine einen
// Trap, wirft der Aufruf {@link CoreTrapError} (er wird NICHT wiederholt), und im Hintergrund entsteht
// eine frische Instanz aus dem schon übersetzten Modul (`__dossier_reinit`, ergänzt von
// `scripts/build-core.mjs`; asynchron, weil Chromium `new WebAssembly.Instance` > 8 MB im Haupt-Thread
// verbietet). Bis sie steht, wirft `core()` {@link CoreRestartingError}. Danach: Epoche +1 (alte
// Kern-Handles ungültig), Wiederherstellungs-Haken (Dokumente öffnen sich aus ihrer Leseansicht neu,
// s. `core/document.ts`), Melde-Haken (Hülle: Meldung, Autosave, Neurendern).

import * as wasm from "./pkgCore/core.js";
import { wasmInitArg } from "./wasmSource";

export type CoreModule = typeof wasm;

let ready = false;
/** Hüllen um alle Kern-Exporte (einmal gebaut; die Exporte der Hülle sprechen immer die aktuelle Instanz an). */
let guarded: CoreModule | null = null;
/** Zahl der Neustarts seit dem Laden (Gültigkeit von Kern-Handles, s. {@link coreEpoch}). */
let epoch = 0;
/** Laufender Neustart (bis dahin wirft `core()`). */
let restart: Promise<void> | null = null;
/** Trap während der Wiederherstellung: der nächste Neustart öffnet nichts neu (sonst Endlosschleife). */
let restoring = false;
let skipRestore = false;
/** Neustart gescheitert: der Kern bleibt tot. */
let dead = false;
/** Zeit der letzten Meldung (Drosselung, s. {@link CoreRestartInfo.quiet}). */
let lastReport = -Infinity;
/** Mindestabstand der Meldungen: ein Panic, den der Render-Pfad gleich wieder auslöst, soll nicht je Runde melden. */
const REPORT_INTERVAL_MS = 5000;

/** Was nach einem Neustart gemeldet wird. */
export interface CoreRestartInfo {
  /** Kern-Funktion, in der der Trap auftrat. */
  fn: string;
  /** Meldung des Traps (die Panic-Meldung selbst steht dank Panic-Hook in der Konsole). */
  message: string;
  /** Neustarts seit dem Laden. */
  restarts: number;
  /** Kurz nach einer anderen Meldung: nur neu zeichnen, nicht erneut melden. */
  quiet: boolean;
}

const restoreHooks: Array<() => void> = [];
const listeners = new Set<(info: CoreRestartInfo) => void>();

/** Fehler eines Kern-Aufrufs, der im Kern einen Panic (Trap) auslöste; der Kern startet im Hintergrund neu. */
export class CoreTrapError extends Error {
  constructor(
    readonly fn: string,
    readonly trap: string,
  ) {
    super(`Interner Fehler im Rust-Kern (${fn}): ${trap}`);
    this.name = "CoreTrapError";
  }
}

/** `core()` während eines Neustarts (kurz, s. {@link coreReady}). */
export class CoreRestartingError extends Error {
  constructor() {
    super("Rust-Kern startet nach einem internen Fehler neu.");
    this.name = "CoreRestartingError";
  }
}

/** Ob `e` von einem Kern-Absturz bzw. -Neustart kommt (Hülle: abwarten statt Fehlerseite). */
export function isCoreRestartError(e: unknown): boolean {
  return e instanceof CoreTrapError || e instanceof CoreRestartingError;
}

/** Ob `e` ein WASM-Trap ist (Rust-Panic → `unreachable`, Speicherfehler, Stapelüberlauf). */
export function isCoreTrap(e: unknown): boolean {
  if (e instanceof CoreTrapError || e instanceof CoreRestartingError) return false;
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError) return true;
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /RuntimeError|unreachable|memory access out of bounds|Maximum call stack size exceeded|recursive use of an object/i.test(msg);
}

/**
 * Wiederherstellung nach einem Neustart (Kern-intern, läuft vor den Meldungen): z. B. Dokumente
 * neu öffnen. Ein Haken darf werfen (wird geloggt), die übrigen laufen trotzdem.
 */
export function registerCoreRestore(hook: () => void): void {
  restoreHooks.push(hook);
}

/** Meldung nach einem Neustart (Hülle: Hinweis, Autosave, Neurendern). Rückgabe: abmelden. */
export function onCoreRestart(listener: (info: CoreRestartInfo) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Zahl der Neustarts: Kern-Handles (gehaltene Puffer, Indizes) aus einer älteren Epoche sind ungültig. */
export function coreEpoch(): number {
  return epoch;
}

/** Erfüllt, sobald kein Neustart mehr läuft (sofort, wenn keiner läuft). */
export async function coreReady(): Promise<void> {
  while (restart) await restart;
}

/** Lädt den Kern asynchron (Browser/Tauri/Electron per URL, Node über den Byte-Provider). */
export async function initCore(): Promise<void> {
  if (ready) return;
  await wasm.default(await wasmInitArg("core"));
  ready = true;
}

/** Lädt den Kern synchron aus vorliegenden Bytes (Node: Tests, Werkzeuge). */
export function initCoreSync(bytes: BufferSource): void {
  if (ready) return;
  wasm.initSync({ module: bytes });
  ready = true;
}

/** Der geladene Kern; wirft, wenn `initCore()` noch nicht gelaufen ist (Programmierfehler) oder er gerade neu startet. */
export function core(): CoreModule {
  if (!ready) throw new Error("Rust-Kern nicht geladen: initCore() muss vor der ersten Kern-Funktion laufen.");
  if (restart) throw new CoreRestartingError();
  if (dead) throw new Error("Rust-Kern nach einem internen Fehler nicht wieder gestartet — bitte die App neu laden.");
  return (guarded ??= buildGuarded());
}

/** Exporte, die nicht in die Instanz rufen (Laden), bleiben ungehüllt. */
const UNGUARDED = new Set(["default", "initSync", "__dossier_reinit"]);

function buildGuarded(): CoreModule {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(wasm)) {
    if (typeof value !== "function" || UNGUARDED.has(name)) {
      out[name] = value;
      continue;
    }
    const f = value as (...args: unknown[]) => unknown;
    out[name] = function (this: unknown, ...args: unknown[]) {
      // Ein Neustart, der während einer laufenden Kette (`const c = core(); …`) begann: nicht in die tote Instanz.
      if (restart) throw new CoreRestartingError();
      try {
        return f.apply(this, args);
      } catch (e) {
        if (isCoreTrap(e)) throw startRestart(name, e);
        throw e;
      }
    };
  }
  return out as CoreModule;
}

/** Nach einem Trap: Neustart anstossen; Ergebnis ist der Fehler für den Aufrufer. */
function startRestart(fn: string, e: unknown): CoreTrapError {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`Rust-Kern abgestürzt in ${fn} — Instanz wird neu gestartet.`, e);
  if (restoring) skipRestore = true;
  if (!restart) restart = runRestart(fn, message);
  return new CoreTrapError(fn, message);
}

async function runRestart(fn: string, message: string): Promise<void> {
  try {
    await wasm.__dossier_reinit();
  } catch (err) {
    // Ohne frische Instanz bleibt der Kern tot (wie vor [118]); nicht still weitermachen.
    console.error("Rust-Kern konnte nicht neu gestartet werden.", err);
    dead = true;
    restart = null;
    return;
  }
  epoch++;
  restart = null;
  const skip = skipRestore;
  skipRestore = false;
  if (!skip) {
    restoring = true;
    try {
      for (const hook of restoreHooks) {
        try {
          hook();
        } catch (err) {
          console.error("Wiederherstellung nach Kern-Neustart unvollständig.", err);
        }
      }
    } finally {
      restoring = false;
    }
  }
  // Ein Trap in den Haken hat schon den nächsten Neustart angestossen: erst danach melden.
  if (restart) return;
  const now = Date.now();
  const quiet = now - lastReport < REPORT_INTERVAL_MS;
  if (!quiet) lastReport = now;
  const info: CoreRestartInfo = { fn, message, restarts: epoch, quiet };
  for (const l of listeners) {
    try {
      l(info);
    } catch (err) {
      console.error(err);
    }
  }
}
