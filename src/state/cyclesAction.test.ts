// [215] Dialog-Logik „Rendering …“ mit dem eingebauten Cycles: Vorgaben, Fortschritt/Restzeit, Abbruch, Fehlerpfade und Aufräumen,
// alles mit Ersatz-`runCycles` (kein Programm nötig). Die Szene kommt aus dem echten Kern (Musterprojekt).
import { describe, expect, it } from "vitest";
import { deflateSync, inflateSync } from "node:zlib";
import { sampleProject } from "../model/sampleProject";
import { makeExr } from "../export/cyclesExr.testutil";
import { buildCyclesPackage, CyclesCancelled, CyclesMissingError } from "../core";
import { pakoCodec } from "../export/zlibCodec";
import { parseCyclesProgress, type CyclesProgress, type CyclesResult } from "../native/cyclesRuntime";
import {
  CYCLES_QUALITIES,
  CyclesRenderError,
  cyclesRunArgs,
  cyclesSamples,
  defaultCyclesDeps,
  defaultEngine,
  errorLines,
  estimateEtaMs,
  formatDuration,
  renderWithCycles,
  type CyclesDeps,
  type CyclesRequest,
  type CyclesStatus,
} from "./cyclesAction";

const project = sampleProject;
const REQ: CyclesRequest = { width: 8, height: 4, samples: 4, denoise: true, when: new Date("2026-06-21T10:00:00Z"), camera: { preset: "iso" }, backfilled: true, context: true };
const exr = (w = 8, h = 4) => makeExr(w, h, new Float32Array(w * h * 3).fill(0.5), true);

/** Ersatz-Abhängigkeiten: Szene aus dem Kern, Programm gespielt, Arbeitsordner protokolliert. */
function deps(over: Partial<CyclesDeps> & { lines?: string[]; code?: number; cancelled?: boolean; image?: Uint8Array | null } = {}): CyclesDeps & { log: string[]; clock: { t: number } } {
  const log: string[] = [];
  const clock = { t: 1000 };
  const { lines: outLines, code, cancelled, image, ...rest } = over;
  return {
    log,
    clock,
    available: async () => true,
    buildPackage: (p, o) => buildCyclesPackage(p, o),
    prepare: async (files) => {
      log.push(`prepare ${files.map((f) => f.path).join(",")}`);
      return "/tmp/dossier-render/42";
    },
    run: async (dir, args, onProgress) => {
      log.push(`run ${dir} ${args.join(" ")}`);
      for (let s = 1; s <= 4; s++) {
        clock.t += 1000 * s; // Sample s braucht s Sekunden
        onProgress({ fraction: s / 4, sample: s, samples: 4 });
      }
      return { code: code ?? 0, cancelled: cancelled ?? false, lines: outLines ?? [] };
    },
    read: async (path) => {
      log.push(`read ${path}`);
      if (image === null) throw new Error("fehlt");
      return image ?? exr();
    },
    cleanup: async (dir) => void log.push(`cleanup ${dir}`),
    codec: { inflate: (d) => new Uint8Array(inflateSync(d)), deflate: (d) => new Uint8Array(deflateSync(d)) },
    now: () => clock.t,
    ...rest,
  };
}

describe("Vorgaben", () => {
  it("Engine: eingebaut, wenn Cycles da ist, sonst Blender", () => {
    expect(defaultEngine(true)).toBe("cycles");
    expect(defaultEngine(false)).toBe("blender");
  });
  it("Qualität: Vorschau 32, Normal 128, Hoch 512; Final (nur Blender) fällt auf Hoch", () => {
    expect(CYCLES_QUALITIES.map((q) => [q.id, q.samples])).toEqual([["draft", 32], ["normal", 128], ["high", 512]]);
    expect(cyclesSamples("draft")).toBe(32);
    expect(cyclesSamples("high")).toBe(512);
    expect(cyclesSamples("final")).toBe(512);
    expect(cyclesSamples("unbekannt")).toBe(128);
  });
  it("Dauer m:ss / h:mm:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(41_400)).toBe("0:41");
    expect(formatDuration(125_000)).toBe("2:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(-5)).toBe("0:00");
  });
  it("Kommandozeile: relative Pfade, Ausgabe als EXR", () => {
    expect(cyclesRunArgs({ width: 320, height: 180, samples: 8 })).toEqual(["--background", "--samples", "8", "--width", "320", "--height", "180", "--output", "render.exr", "scene.xml"]);
  });
  it("Fehlerzeilen: Fehler zuerst, sonst die letzten drei", () => {
    expect(errorLines(["a", "00:00 | ERROR: kaputt", "b"])).toBe("00:00 | ERROR: kaputt");
    expect(errorLines(["1", "2", "3", "4"])).toBe("2 | 3 | 4");
    expect(errorLines([])).toBe("");
  });
});

describe("Fortschritt-Parser an der Anbindung", () => {
  it("Zeilen des Programms ergeben Sample n/N, andere Zeilen keinen Fortschritt", () => {
    const seen: CyclesProgress[] = [];
    for (const l of ["Updating Scene", "Progress 25.00   Sample 8/32", "Progress 50.00   Sample 16/32", "Writing image render.exr"]) {
      const p = parseCyclesProgress(l);
      if (p) seen.push(p);
    }
    expect(seen).toEqual([{ fraction: 0.25, sample: 8, samples: 32 }, { fraction: 0.5, sample: 16, samples: 32 }]);
  });
  it("Restzeit: ab dem zweiten Sample, aus dem Takt seit dem ersten", () => {
    expect(estimateEtaMs(0, 1, 5000, 1, 32)).toBeNull(); // erstes Sample (Kernel-Übersetzung zählt nicht)
    expect(estimateEtaMs(0, 1, 2000, 3, 11)).toBe(8000); // 2 Samples in 2 s → 1 s je Sample, 8 fehlen
    expect(estimateEtaMs(0, 1, 2000, 11, 11)).toBe(0);
    expect(estimateEtaMs(5000, 1, 5000, 4, 8)).toBeNull(); // keine Zeit vergangen
  });
});

describe("renderWithCycles", () => {
  it("Ablauf: Szene aus dem Kern, Programm mit Argumenten, EXR → PNG, Fortschritt mit Restzeit, Ordner aufgeräumt", async () => {
    const d = deps();
    const stages: CyclesStatus[] = [];
    const img = await renderWithCycles(project, REQ, { onStatus: (s) => stages.push(s) }, d);
    expect([img.width, img.height]).toEqual([8, 4]);
    expect(Array.from(img.png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(d.log[0]).toMatch(/^prepare scene\.xml/);
    expect(d.log[1]).toBe("run /tmp/dossier-render/42 --background --samples 4 --width 8 --height 4 --output render.exr scene.xml");
    expect(d.log.slice(2)).toEqual(["read /tmp/dossier-render/42/render.exr", "cleanup /tmp/dossier-render/42"]);
    expect(stages.map((s) => s.stage)).toEqual(["scene", "start", "render", "render", "render", "render", "tonemap", "done"]);
    const render = stages.filter((s) => s.stage === "render");
    expect(render.map((s) => s.sample)).toEqual([1, 2, 3, 4]);
    expect(render[0].etaMs).toBeNull();
    // Sample 2 kam 2 s nach Sample 1 → 2 s je Sample, noch 2 Samples = 4 s; Sample 3 nach 5 s für 2 Samples → 2.5 s je Sample, 1 fehlt
    expect(render[1].etaMs).toBeCloseTo(4000, 0);
    expect(render[2].etaMs).toBeCloseTo(2500, 0);
    expect(render[3].etaMs).toBe(0);
    expect(render[3].elapsedMs).toBe(10_000);
    expect(img.millis).toBeGreaterThan(0);
  });

  it("Optionen kommen im Kern an: Grösse, Samples, Entrauschen, Belichtung, Kontext aus", async () => {
    let seen: Parameters<CyclesDeps["buildPackage"]>[1] | null = null;
    const d = deps({ buildPackage: (p, o) => ((seen = o), buildCyclesPackage(p, o)) });
    await renderWithCycles(project, { ...REQ, denoise: false, context: false, exposureEv: 1.5 }, {}, d);
    expect(seen).toMatchObject({ width: 8, height: 4, samples: 4, denoise: false, context: false, exposureEv: 1.5, whenMs: REQ.when.getTime(), camera: { preset: "iso" } });
  });

  it("Belichtungskorrektur wirkt beim Tonwert: andere Bytes als ohne", async () => {
    const a = await renderWithCycles(project, REQ, {}, deps());
    const b = await renderWithCycles(project, { ...REQ, extraEv: 2 }, {}, deps());
    const c = await renderWithCycles(project, { ...REQ, extraEv: Number.NaN }, {}, deps());
    expect(Buffer.from(b.png).equals(Buffer.from(a.png))).toBe(false);
    expect(Buffer.from(c.png).equals(Buffer.from(a.png))).toBe(true);
  });

  it("Browser/ohne Cycles: CyclesMissingError, nichts angelegt", async () => {
    const d = deps({ available: async () => false });
    await expect(renderWithCycles(project, REQ, {}, d)).rejects.toBeInstanceOf(CyclesMissingError);
    expect(d.log).toEqual([]);
  });

  it("Abbruch während des Laufs: CyclesCancelled, Ordner trotzdem gelöscht, kein Lesen", async () => {
    const ac = new AbortController();
    const d = deps({
      run: async (_dir, _a, onProgress, signal) => {
        onProgress({ fraction: 0.25, sample: 1, samples: 4 });
        ac.abort();
        expect(signal?.aborted).toBe(true);
        return { code: -1, cancelled: true, lines: [] } satisfies CyclesResult;
      },
    });
    await expect(renderWithCycles(project, REQ, { signal: ac.signal }, d)).rejects.toBeInstanceOf(CyclesCancelled);
    expect(d.log).toHaveLength(2);
    expect(d.log[0]).toMatch(/^prepare scene\.xml/);
    expect(d.log[1]).toBe("cleanup /tmp/dossier-render/42");
    expect(d.log.some((l) => l.startsWith("read"))).toBe(false);
  });

  it("schon abgebrochen: gar nichts wird angelegt", async () => {
    const ac = new AbortController();
    ac.abort();
    const d = deps();
    await expect(renderWithCycles(project, REQ, { signal: ac.signal }, d)).rejects.toBeInstanceOf(CyclesCancelled);
    expect(d.log).toEqual([]);
  });

  it("Absturz (Code ≠ 0): CyclesRenderError crashed mit Fehlerzeilen, Ordner gelöscht", async () => {
    const d = deps({ code: 139, lines: ["Loading render kernels", "00:01 | ERROR: Out of memory"] });
    const err = await renderWithCycles(project, REQ, {}, d).catch((e) => e);
    expect(err).toBeInstanceOf(CyclesRenderError);
    expect(err).toMatchObject({ kind: "crashed", code: 139, detail: "00:01 | ERROR: Out of memory" });
    expect(d.log.at(-1)).toBe("cleanup /tmp/dossier-render/42");
  });

  it("Programm schreibt kein Bild: nofile; kaputtes EXR: Fehler, Ordner gelöscht", async () => {
    const d1 = deps({ image: null });
    await expect(renderWithCycles(project, REQ, {}, d1)).rejects.toMatchObject({ kind: "nofile" });
    expect(d1.log.at(-1)).toBe("cleanup /tmp/dossier-render/42");
    const d2 = deps({ image: new Uint8Array(40) });
    await expect(renderWithCycles(project, REQ, {}, d2)).rejects.toThrow("Kein OpenEXR");
    expect(d2.log.at(-1)).toBe("cleanup /tmp/dossier-render/42");
  });

  it("Start scheitert (Hauptprozess lehnt ab): kind start mit der Meldung", async () => {
    const d = deps({
      run: async () => {
        throw new Error("Schalter nicht erlaubt: --help");
      },
    });
    await expect(renderWithCycles(project, REQ, {}, d)).rejects.toMatchObject({ kind: "start", detail: "Schalter nicht erlaubt: --help" });
    expect(d.log.at(-1)).toBe("cleanup /tmp/dossier-render/42");
  });

  it("leeres Modell: empty, nichts gestartet", async () => {
    const d = deps({ buildPackage: async (p, o) => ({ ...(await buildCyclesPackage(p, o)), info: { ...(await buildCyclesPackage(p, o)).info, meshes: 0 } }) });
    await expect(renderWithCycles(project, REQ, {}, d)).rejects.toMatchObject({ kind: "empty" });
    expect(d.log).toEqual([]);
  });

  it("Aufräumen darf nicht scheitern lassen", async () => {
    const d = deps({
      cleanup: async () => {
        throw new Error("gesperrt");
      },
    });
    await expect(renderWithCycles(project, REQ, {}, d)).resolves.toMatchObject({ width: 8 });
  });
});

describe("Standard-Abhängigkeiten", () => {
  it("im Test (kein Fenster): Cycles nicht verfügbar, Zlib des Browsers rechnet wie node:zlib", async () => {
    expect(await defaultCyclesDeps.available()).toBe(false);
    const raw = new Uint8Array(5000).map((_, i) => (i * 7) & 255);
    expect(Array.from(pakoCodec.inflate(new Uint8Array(deflateSync(raw))))).toEqual(Array.from(raw));
    expect(Array.from(new Uint8Array(inflateSync(pakoCodec.deflate(raw))))).toEqual(Array.from(raw));
  });
});
