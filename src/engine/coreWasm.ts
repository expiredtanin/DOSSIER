// Lader des Rust-Kerns (`src-tauri/core` → `src/engine/pkgCore`). Der Kern wird EINMAL geladen —
// App: `initCore()` vor dem ersten Render (main.tsx), CLI: `initCore()` mit Byte-Provider
// (wasmSource.ts), Tests: `initCoreSync()` in der Vitest-Setup-Datei — und danach synchron über
// `core()` aufgerufen, passend zu den synchronen Aufrufern im TS-Kern.
//
// Wiederanlauf nach einem Panic ([118]): wasm32 kennt kein catch_unwind — ein Rust-Panic endet als
// Trap (`WebAssembly.RuntimeError: unreachable`), danach ist die Instanz unbrauchbar (geborgte
// RefCells, verwaister Zustand). `core()` liefert deshalb Hüllen um die Exporte: fängt eine einen
// Trap, wird sofort eine frische Instanz aus dem schon übersetzten Modul gebaut (`__dossier_reinit`,
// ergänzt von `scripts/patch-core-glue.mjs`), die Wiederherstellungs-Haken laufen (Dokumente öffnen
// sich aus ihrer Leseansicht neu, s. `core/document.ts`), die Melde-Haken bekommen Bescheid (Hülle:
// Meldung + Autosave) — und der Aufruf wirft {@link CoreTrapError}. Er wird NICHT wiederholt.

import * as wasm from "./pkgCore/core.js";
import { wasmInitArg } from "./wasmSource";

export type CoreModule = typeof wasm;

let ready = false;
/** Hüllen um alle Kern-Exporte (einmal gebaut; die Exporte der Hülle sprechen immer die aktuelle Instanz an). */
let guarded: CoreModule | null = null;
/** Zahl der Neustarts seit dem Laden (Gültigkeit von Kern-Handles, s. {@link coreEpoch}). */
let epoch = 0;
let restoring = false;
/** Zeit der letzten Meldung an die Hülle (Drosselung, s. {@link restartAfterTrap}). */
let lastReport = -Infinity;
/** Mindestabstand der Meldungen: ein Panic, den der Render-Pfad gleich wieder auslöst, darf keine Schleife aus Meldung → Neurendern → Panic bilden. */
const REPORT_INTERVAL_MS = 5000;

/** Was beim Neustart gemeldet wird. */
export interface CoreRestartInfo {
  /** Kern-Funktion, in der der Trap auftrat. */
  fn: string;
  /** Meldung des Traps (die Panic-Meldung selbst steht dank Panic-Hook in der Konsole). */
  message: string;
  /** Neustarts seit dem Laden. */
  restarts: number;
}

const restoreHooks: Array<() => void> = [];
const listeners = new Set<(info: CoreRestartInfo) => void>();

/** Fehler eines Kern-Aufrufs, der im Kern einen Panic (Trap) auslöste; der Kern läuft danach schon wieder. */
export class CoreTrapError extends Error {
  constructor(
    readonly fn: string,
    readonly trap: string,
  ) {
    super(`Interner Fehler im Rust-Kern (${fn}): ${trap}`);
    this.name = "CoreTrapError";
  }
}

/** Ob `e` ein WASM-Trap ist (Rust-Panic → `unreachable`, Speicherfehler, Stapelüberlauf). */
export function isCoreTrap(e: unknown): boolean {
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

/** Meldung nach einem Neustart (Hülle: Hinweis, Autosave, Verlaufsanzeige), als Microtask nach dem Aufruf. Rückgabe: abmelden. */
export function onCoreRestart(listener: (info: CoreRestartInfo) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Zahl der Neustarts: Kern-Handles (gehaltene Puffer, Indizes) aus einer älteren Epoche sind ungültig. */
export function coreEpoch(): number {
  return epoch;
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

/** Der geladene Kern; wirft, wenn `initCore()` noch nicht gelaufen ist (Programmierfehler). */
export function core(): CoreModule {
  if (!ready) throw new Error("Rust-Kern nicht geladen: initCore() muss vor der ersten Kern-Funktion laufen.");
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
      try {
        return f.apply(this, args);
      } catch (e) {
        if (isCoreTrap(e)) throw restartAfterTrap(name, e);
        throw e;
      }
    };
  }
  return out as CoreModule;
}

/** Nach einem Trap: neue Instanz, Wiederherstellung, Meldung; Ergebnis ist der Fehler für den Aufrufer. */
function restartAfterTrap(fn: string, e: unknown): CoreTrapError {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`Rust-Kern abgestürzt in ${fn} — Instanz wird neu gestartet.`, e);
  try {
    wasm.__dossier_reinit();
  } catch (err) {
    // Ohne frische Instanz bleibt der Kern tot (wie vor [118]); nicht still weitermachen.
    console.error("Rust-Kern konnte nicht neu gestartet werden.", err);
    return new CoreTrapError(fn, message);
  }
  epoch++;
  // Trap während der Wiederherstellung (das Projekt selbst bringt den Kern zu Fall): Instanz ist
  // wieder frisch, der Fehler geht an den Haken, keine weitere Runde.
  if (restoring) return new CoreTrapError(fn, message);
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
  const now = Date.now();
  if (now - lastReport >= REPORT_INTERVAL_MS) {
    lastReport = now;
    const info: CoreRestartInfo = { fn, message, restarts: epoch };
    // Nach dem laufenden Aufruf melden: der Trap kann mitten im Rendern liegen (Store-Änderung dort verboten).
    queueMicrotask(() => {
      for (const l of listeners) {
        try {
          l(info);
        } catch (err) {
          console.error(err);
        }
      }
    });
  }
  return new CoreTrapError(fn, message);
}
