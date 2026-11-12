// Blender als eigener Prozess aus der App ([211], Rendering mit Blender/Cycles): Gastgeber für
// `export/blenderRender.ts` (`BlenderHost`) unter Tauri (Rust-Befehle in `src-tauri/src/blender.rs`, Dateien über
// das fs-Plugin im Ordner `$TEMP/dossier-render`) und Electron (`window.dossierBlender`, Hauptprozess
// `scripts/electron-blender.cjs`). Im reinen Browser gibt es keinen Prozess: `blenderHost()` liefert null, die
// App bietet dort das Paket als ZIP an (`ui/RenderDialog.tsx`).
//
// Die Tauri-Plugins werden NUR dynamisch importiert (Muster `saveFile.ts`): Browser-Build und vitest brauchen
// die Module nicht. Nicht auf dem Mac geprüft: Tauri-Teil nach Muster geschrieben (nur im Linux-Container
// kompiliert und die Rust-Logik getestet).

import type { BlenderHost } from "../core";

/** Von electron-preload.cjs injiziert (nur Electron/Linux). */
export interface DossierBlenderApi {
  find: (custom?: string) => Promise<string | null>;
  prepare: (files: { path: string; bytes: Uint8Array }[]) => Promise<string>;
  start: (jobId: string, exe: string, args: string[]) => Promise<void>;
  cancel: (jobId: string) => void;
  readFile: (path: string) => Promise<Uint8Array>;
  onLine: (cb: (e: { jobId: string; line: string }) => void) => () => void;
  onExit: (cb: (e: { jobId: string; code: number }) => void) => () => void;
}

declare global {
  interface Window {
    dossierBlender?: DossierBlenderApi;
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let counter = 0;
const newJobId = (): string => `render-${Date.now().toString(36)}-${counter++}`;

const join = (dir: string, rel: string): string => `${dir.replace(/[\\/]+$/, "")}/${rel}`;

/**
 * Tauri-Gastgeber. Befehle: `blender_find`, `blender_job_dir`, `blender_start`, `blender_cancel`;
 * Ereignisse `blender://line` und `blender://exit` mit der Auftragskennung.
 */
async function tauriHost(): Promise<BlenderHost> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const fs = await import("@tauri-apps/plugin-fs");
  return {
    find: (custom) => invoke<string | null>("blender_find", { custom: custom?.trim() || null }),
    async prepare(files) {
      const dir = await invoke<string>("blender_job_dir");
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
    spawn(exe, args, onLine) {
      const jobId = newJobId();
      const done = (async () => {
        let resolveExit!: (code: number) => void;
        const exit = new Promise<number>((r) => (resolveExit = r));
        const offLine = await listen<{ jobId: string; line: string }>("blender://line", (e) => {
          if (e.payload.jobId === jobId) onLine(e.payload.line);
        });
        const offExit = await listen<{ jobId: string; code: number }>("blender://exit", (e) => {
          if (e.payload.jobId === jobId) resolveExit(e.payload.code);
        });
        try {
          await invoke("blender_start", { jobId, exe, args });
          return await exit;
        } finally {
          offLine();
          offExit();
        }
      })();
      return { done, cancel: () => void invoke("blender_cancel", { jobId }).catch(() => undefined) };
    },
    readFile: (path) => fs.readFile(path),
    join,
  };
}

/** Electron-Gastgeber über die Brücke aus `electron-preload.cjs`. */
function electronHost(api: DossierBlenderApi): BlenderHost {
  return {
    find: (custom) => api.find(custom?.trim() || undefined),
    prepare: (files) => api.prepare(files),
    spawn(exe, args, onLine) {
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
        .start(jobId, exe, args)
        .then(() => exit)
        .finally(() => {
          offLine();
          offExit();
        });
      return { done, cancel: () => api.cancel(jobId) };
    },
    readFile: (path) => api.readFile(path),
    join,
  };
}

/** Gastgeber der laufenden Umgebung, oder null (reiner Browser: kein Prozess möglich). */
export async function blenderHost(): Promise<BlenderHost | null> {
  if (typeof window === "undefined") return null;
  if (window.dossierBlender) return electronHost(window.dossierBlender);
  if (isTauri()) return tauriHost();
  return null;
}

/** Öffnet eine Web-Adresse im System-Browser (Tauri: shell-Plugin; sonst neuer Tab). */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
