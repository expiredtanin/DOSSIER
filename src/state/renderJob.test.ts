// [277] Auftrag des Renderings im Hauptfenster: Stand, Fortschritt, Abbruch, Fehler, Speichern — mit Ersatz-Renderern
// (kein Cycles/Blender nötig). Die Oberfläche (Fenster/Overlay) sieht nur diesen Stand und schickt Befehle.
import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { CyclesCancelled, CyclesMissingError } from "../core";
import { CyclesRenderError, type CyclesHooks, type CyclesRequest } from "./cyclesAction";
import { RenderJobController, buildRenderSetupInfo, IDLE_RENDER_JOB, isRenderBusy, type RenderJobDeps, type RenderJobRequest, type RenderJobState } from "./renderJob";

const REQ: RenderJobRequest = {
  engine: "cycles",
  width: 320,
  height: 180,
  samples: 8,
  denoise: true,
  whenMs: Date.UTC(2026, 5, 21, 12, 0, 0),
  cameraKey: "live",
  backfilled: true,
  context: true,
  exposureEv: 0,
  useView: true,
  renoColors: false,
  blenderPath: "",
};
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

interface Harness {
  deps: RenderJobDeps;
  notes: string[];
  saved: { name: string; mime: string }[];
  placed: string[];
  seen: CyclesRequest[];
  /** Hält den Cycles-Lauf an, bis `release()` (für Abbruch und Zwischenstände). */
  gate: { release: () => void; started: Promise<void> };
}

function harness(over: Partial<RenderJobDeps> = {}): Harness {
  const notes: string[] = [];
  const saved: { name: string; mime: string }[] = [];
  const placed: string[] = [];
  const seen: CyclesRequest[] = [];
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const deps: RenderJobDeps = {
    project: () => sampleProject,
    activeLevelId: () => sampleProject.drawingLevels[0]?.id ?? "",
    notify: (text) => void notes.push(text),
    cyclesAvailable: async () => true,
    renderHost: async () => null,
    liveCamera: () => ({ preset: "front" }),
    activeView: () => ({ view: {}, labels: { renovation: null, combination: null } }),
    renderWithCycles: async (_p: unknown, req: CyclesRequest, hooks: CyclesHooks = {}) => {
      await Promise.resolve();
      seen.push(req);
      hooks.onStatus?.({ stage: "scene", fraction: 0, sample: 0, samples: req.samples, elapsedMs: 0, etaMs: null });
      hooks.onStatus?.({ stage: "render", fraction: 0.5, sample: 4, samples: req.samples, elapsedMs: 10, etaMs: 5 });
      started();
      await hold;
      if (hooks.signal?.aborted) throw new CyclesCancelled();
      return { png: PNG, width: req.width, height: req.height, millis: 1234 };
    },
    buildPackage: async () => {
      throw new Error("nicht benötigt");
    },
    renderWithBlender: async () => {
      throw new Error("nicht benötigt");
    },
    saveBlendWithBlender: async () => {
      throw new Error("nicht benötigt");
    },
    openInBlender: async () => {
      throw new Error("nicht benötigt");
    },
    packageAsZip: async () => new Uint8Array(),
    saveBinaryFile: async (_b, name, mime) => {
      saved.push({ name, mime: mime ?? "" });
      return true;
    },
    gate: (_p, _names, run) => void run(),
    placeImage: (id) => {
      placed.push(id);
      return true;
    },
    now: () => 5000,
    ...over,
  };
  return { deps, notes, saved, placed, seen, gate: { release, started: startedP } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("RenderJobController", () => {
  it("Cycles-Lauf: Vorbereiten → Rechnen → fertig mit Bild; Anfrage mit aufgelöster Kamera und Zeit", async () => {
    const h = harness();
    const job = new RenderJobController(h.deps);
    const phases: string[] = [];
    job.subscribe(() => phases.push(job.getState().phase));
    job.start(REQ);
    expect(job.getState().phase).toBe("preparing");
    expect(isRenderBusy(job.getState())).toBe(true);
    await h.gate.started;
    expect(job.getState().phase).toBe("running");
    expect(job.getState().fraction).toBe(0.5);
    expect(job.getState().status).toContain("4");
    expect(job.getState().startedAt).toBe(5000);
    h.gate.release();
    await tick();
    const s = job.getState();
    expect(s.phase).toBe("done");
    expect(s.hasImage).toBe(true);
    expect(s.elapsedMs).toBe(1234);
    expect(s.dims).toEqual({ width: 320, height: 180 });
    expect(job.getImage()).toBe(PNG);
    // Kamera „live“ aus dem Hauptfenster gelesen, Zeit als Date, ohne Ansicht-Filter.
    expect(h.seen[0].camera).toEqual({ preset: "front" });
    expect(h.seen[0].when.getTime()).toBe(REQ.whenMs);
    expect(h.seen[0].view).toBeUndefined();
    expect(phases).toContain("running");
  });

  it("Abbrechen: zurück zu den Einstellungen mit Meldung, kein Bild", async () => {
    const h = harness();
    const job = new RenderJobController(h.deps);
    job.start(REQ);
    await h.gate.started;
    job.abort();
    h.gate.release();
    await tick();
    expect(job.getState().phase).toBe("setup");
    expect(job.getState().message).toBe("Rendering abgebrochen");
    expect(job.getState().hasImage).toBe(false);
    expect(isRenderBusy(job.getState())).toBe(false);
  });

  it("zweiter Start während der Arbeit wird ignoriert, Zurücksetzen auch", async () => {
    const h = harness();
    const job = new RenderJobController(h.deps);
    job.start(REQ);
    await h.gate.started;
    job.start(REQ);
    job.reset();
    expect(h.seen.length).toBe(1);
    expect(job.getState().phase).toBe("running");
    // Das Zurücksetzen (Fenster zu) wird nach dem Abbruch nachgeholt: keine Meldung „abgebrochen“ beim nächsten Öffnen.
    job.abort();
    h.gate.release();
    await tick();
    expect(job.getState().phase).toBe("setup");
    expect(job.getState().message).toBe("");
  });

  it("Fehler des Programms: Meldung im Stand und Hinweis im Hauptfenster", async () => {
    const h = harness({
      renderWithCycles: async () => {
        throw new CyclesRenderError("crashed", 3, "boom");
      },
    });
    const job = new RenderJobController(h.deps);
    job.start(REQ);
    await tick();
    expect(job.getState().phase).toBe("error");
    expect(job.getState().message).toContain("3");
    expect(h.notes).toHaveLength(1);
  });

  it("Cycles fehlt: Fehlerphase mit Meldung", async () => {
    const h = harness({
      renderWithCycles: async () => {
        throw new CyclesMissingError();
      },
    });
    const job = new RenderJobController(h.deps);
    job.start(REQ);
    await tick();
    expect(job.getState().phase).toBe("error");
    expect(h.notes).toHaveLength(1);
  });

  it("Speichern und Einsetzen laufen durch das Anonymitäts-Tor und melden im Stand", async () => {
    const h = harness();
    const gated: string[][] = [];
    const deps = { ...h.deps, gate: (_p: unknown, names: string[], run: () => void | Promise<void>) => (gated.push(names), void run()) } as RenderJobDeps;
    const job = new RenderJobController(deps);
    job.savePng(); // ohne Bild: nichts
    expect(h.saved).toHaveLength(0);
    job.start(REQ);
    await h.gate.started;
    h.gate.release();
    await tick();
    job.savePng();
    await tick();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].mime).toBe("image/png");
    expect(h.saved[0].name).toMatch(/-rendering\.png$/);
    expect(gated).toHaveLength(1);
    expect(job.getState().notice).toBe("Rendering gespeichert");
    const layout = sampleProject.layouts?.[0];
    if (layout) {
      job.placeInLayout(layout.id);
      expect(h.placed).toEqual([layout.id]);
    }
    job.placeInLayout("gibt-es-nicht");
    expect(job.getState().notice).not.toBeNull();
  });

  it("Zurücksetzen nach dem Bild: Einstellungen wieder, Bild verworfen; Erkennung bleibt", async () => {
    const h = harness();
    const job = new RenderJobController(h.deps);
    job.detectEnvironment();
    await tick();
    expect(job.getState().cyclesOk).toBe(true);
    expect(job.getState().hasHost).toBe(false);
    job.start(REQ);
    await h.gate.started;
    h.gate.release();
    await tick();
    const seq = job.getState().imageSeq;
    job.reset();
    const s = job.getState();
    expect(s.phase).toBe("setup");
    expect(s.hasImage).toBe(false);
    expect(s.imageSeq).toBeGreaterThan(seq);
    expect(job.getImage()).toBeNull();
    expect(s.cyclesOk).toBe(true);
  });

  it("Ausgangsstand ist JSON-tauglich (geht unverändert über die Fenster-Brücke)", () => {
    const back = JSON.parse(JSON.stringify(IDLE_RENDER_JOB)) as RenderJobState;
    expect(back).toEqual(IDLE_RENDER_JOB);
  });
});

describe("buildRenderSetupInfo", () => {
  it("Vorgaben aus dem Projekt, nur Daten (JSON-tauglich)", () => {
    const info = buildRenderSetupInfo({ project: () => sampleProject, activeLevelId: () => sampleProject.drawingLevels[0]?.id ?? "", activeView: () => ({ view: {}, labels: { renovation: null, combination: null } }) });
    expect(Number.isFinite(info.defaultWhenMs)).toBe(true);
    expect(Number.isFinite(info.latLon.lat)).toBe(true);
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
    expect(info.layouts.map((l) => l.id)).toEqual((sampleProject.layouts ?? []).map((l) => l.id));
  });
});
