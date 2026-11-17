// [215] Cycles-Fassade (src/native/cyclesRuntime.ts) mit einer Brücke als Ersatz für den Hauptprozess; Browser: nicht verfügbar.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupCyclesScene, cyclesAvailable, parseCyclesProgress, prepareCyclesScene, runCycles, type DossierCyclesApi } from "./cyclesRuntime";

type G = { window?: { dossierCycles?: DossierCyclesApi } };
const g = globalThis as unknown as G;
afterEach(() => {
  delete g.window;
});

/** Ersatz-Brücke: `start` meldet die Zeilen und das Ende nach `exitAfterMs`, `cancel` beendet sofort mit -1. */
function fakeApi(opts: { exe?: string | null; lines?: string[]; code?: number; hang?: boolean } = {}): DossierCyclesApi & { started: unknown[][]; cancelled: string[]; cleaned: string[] } {
  const lineCbs = new Set<(e: { jobId: string; line: string }) => void>();
  const exitCbs = new Set<(e: { jobId: string; code: number }) => void>();
  const started: unknown[][] = [];
  const cancelled: string[] = [];
  const cleaned: string[] = [];
  return {
    started,
    cancelled,
    cleaned,
    cleanup: async (dir) => void cleaned.push(dir),
    where: async () => (opts.exe === undefined ? "/res/cycles/cycles" : opts.exe),
    prepare: async () => "/tmp/dossier-render/1",
    readFile: async () => new Uint8Array([1, 2, 3]),
    start: async (jobId, dir, args) => {
      started.push([jobId, dir, args]);
      queueMicrotask(() => {
        for (const line of opts.lines ?? []) for (const cb of lineCbs) cb({ jobId, line });
        if (!opts.hang) for (const cb of exitCbs) cb({ jobId, code: opts.code ?? 0 });
      });
    },
    cancel: (jobId) => {
      cancelled.push(jobId);
      for (const cb of exitCbs) cb({ jobId, code: -1 });
    },
    onLine: (cb) => (lineCbs.add(cb), () => lineCbs.delete(cb)),
    onExit: (cb) => (exitCbs.add(cb), () => exitCbs.delete(cb)),
  };
}

describe("parseCyclesProgress", () => {
  it("liest 'Progress 06.25   Sample 1/16'", () => {
    expect(parseCyclesProgress("Progress 06.25   Sample 1/16                    ")).toEqual({ fraction: 0.0625, sample: 1, samples: 16 });
    expect(parseCyclesProgress("Progress 100.00   Sample 16/16")).toEqual({ fraction: 1, sample: 16, samples: 16 });
  });
  it("andere Zeilen sind kein Fortschritt", () => {
    for (const l of ["Updating Scene BVH", "Writing image out.png", "Progress 100.00   Finished", "Loading render kernels (may take a few minutes the first time)", ""]) {
      expect(parseCyclesProgress(l)).toBeNull();
    }
  });
});

describe("cyclesAvailable / runCycles", () => {
  it("Browser (kein Fenster, keine Brücke, kein Tauri): nicht verfügbar", async () => {
    expect(await cyclesAvailable()).toBe(false);
    g.window = {};
    expect(await cyclesAvailable()).toBe(false);
    await expect(prepareCyclesScene([])).rejects.toThrow(/nicht verfügbar/);
    await expect(runCycles("/x", [], () => {})).rejects.toThrow(/nicht verfügbar/);
  });

  it("Paket ohne Cycles (where = null): nicht verfügbar", async () => {
    g.window = { dossierCycles: fakeApi({ exe: null }) };
    expect(await cyclesAvailable()).toBe(false);
  });

  it("Electron-Brücke: verfügbar, Fortschritt, Exit-Code, übrige Zeilen", async () => {
    const api = fakeApi({ lines: ["Updating Scene", "Progress 50.00   Sample 8/16", "Progress 100.00   Sample 16/16", "Writing image out.png"], code: 0 });
    g.window = { dossierCycles: api };
    expect(await cyclesAvailable()).toBe(true);
    expect(await prepareCyclesScene([])).toBe("/tmp/dossier-render/1");
    const seen: number[] = [];
    const r = await runCycles("/tmp/dossier-render/1", ["--background", "szene.xml"], (p) => seen.push(p.sample));
    expect(seen).toEqual([8, 16]);
    expect(r).toEqual({ code: 0, cancelled: false, lines: ["Updating Scene", "Writing image out.png"] });
    expect(api.started[0].slice(1)).toEqual(["/tmp/dossier-render/1", ["--background", "szene.xml"]]);
  });

  it("Abbruch per Signal beendet den Prozess", async () => {
    const api = fakeApi({ lines: ["Progress 10.00   Sample 1/10"], hang: true });
    g.window = { dossierCycles: api };
    const ac = new AbortController();
    const r = runCycles("/tmp/dossier-render/1", ["szene.xml"], () => ac.abort(), ac.signal);
    expect(await r).toMatchObject({ cancelled: true, code: -1 });
    expect(api.cancelled).toHaveLength(1);
  });

  it("schon abgebrochenes Signal startet nichts", async () => {
    const api = fakeApi();
    g.window = { dossierCycles: api };
    const ac = new AbortController();
    ac.abort();
    expect(await runCycles("/tmp/dossier-render/1", ["szene.xml"], () => {}, ac.signal)).toMatchObject({ cancelled: true });
    expect(api.started).toEqual([]);
  });
});

describe("cleanupCyclesScene", () => {
  it("löscht den Arbeitsordner über die Brücke; Fehler werden geschluckt", async () => {
    const api = fakeApi();
    g.window = { dossierCycles: api };
    await cleanupCyclesScene("/tmp/dossier-render/1");
    expect(api.cleaned).toEqual(["/tmp/dossier-render/1"]);
    api.cleanup = async () => {
      throw new Error("weg");
    };
    await expect(cleanupCyclesScene("/tmp/dossier-render/2")).resolves.toBeUndefined();
    // Browser: nichts zu tun, kein Fehler
    delete g.window;
    await expect(cleanupCyclesScene("/x")).resolves.toBeUndefined();
  });
});
