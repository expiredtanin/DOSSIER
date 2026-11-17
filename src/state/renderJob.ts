// [277] Rendering als eigenes Fenster: der Auftrag (Szene aus dem Kern, Cycles-/Blender-Prozess, Fortschritt, Abbruch, Bild) läuft
// im HAUPTFENSTER — dort liegt das Projekt (Kern-Dokument), die Szene wird nicht doppelt gehalten. Das Rendering-Fenster
// (`native/RenderWindowApp.tsx`, Brücke `native/renderWindow.ts`) und im Browser der Overlay-Dialog (`ui/RenderDialog.tsx`) zeigen nur
// die Einstellungen, den Stand dieses Auftrags und schicken Befehle (`RenderCommands`). Der Stand ist reine Daten (JSON-tauglich);
// das fertige PNG bleibt hier und geht nur als Vorschau (Base64) ans Fenster.
//
// Ohne Oberfläche und mit austauschbaren Abhängigkeiten (`RenderJobDeps`), damit vitest die Abläufe (Vorgaben, Fortschritt,
// Abbruch, Fehler, Speichern) mit Ersatz-Renderern prüft. Rechnen selbst: `renderAction.ts` (Blender), `cyclesAction.ts` (Cycles).

import { useSyncExternalStore } from "react";
import {
  BlenderMissingError,
  CyclesCancelled,
  CyclesMissingError,
  RenderCancelled,
  defaultRenderTime,
  exportProjectName,
  hasExportView,
  projectLatLon,
  projectRenderCameras,
  type BlenderHost,
  type RenderCameraSpec,
  type RenderViewPreset,
  type ExportView,
} from "../core";
import type { Project } from "../model/types";
import { dataEqual } from "./dataEqual";
import { getState } from "./appStore";
import { getBlenderPath, setBlenderPath } from "./blenderSettings";
import { buildPackage, currentRenderCamera, openInBlender, packageAsZip, presetForView3d, renderHost, renderWithBlender, saveBlendWithBlender } from "./renderAction";
import {
  CyclesRenderError,
  renderWithCycles,
  type CyclesRequest,
  type CyclesStatus,
  type RenderEngine,
} from "./cyclesAction";
import { cyclesAvailable } from "../native/cyclesRuntime";
import { saveBinaryFile } from "../native/saveFile";
import { getCamera } from "../viewport/cameraBridge";
import { runWithAnonymityGate } from "./anonymityGate";
import { defaultTargetLayout, placeImageOnLayout } from "./layoutImageActions";
import { activeExportView, type ActiveExportView } from "./exportViewState";
import { t } from "../i18n";

/** Was gerade läuft: Bild rechnen, .blend speichern, in Blender öffnen. */
export type RenderJobKind = "render" | "save" | "open";

export type RenderPhase = "setup" | "preparing" | "running" | "done" | "error" | "missing";

/** Alles, was die Oberfläche (Fenster oder Overlay) über den laufenden Auftrag wissen muss. */
export interface RenderJobState {
  phase: RenderPhase;
  job: RenderJobKind;
  /** Renderer des laufenden bzw. letzten Auftrags. */
  engine: RenderEngine;
  status: string;
  fraction: number;
  message: string;
  /** Letzte Ausgabezeile von Blender (zeigt z. B. das Übersetzen der Metal-Kernel, das Minuten dauern kann). */
  lastLine: string;
  cyclesStatus: CyclesStatus | null;
  /** Startzeit des Auftrags (ms, Uhr dieses Rechners): die Oberfläche zählt die verstrichene Zeit selbst. */
  startedAt: number;
  /** Gesamtdauer des fertigen Cycles-Bildes. */
  elapsedMs: number;
  /** Rückmeldung zu Speichern/Einsetzen (bis zum nächsten Auftrag). */
  notice: string | null;
  /** Gibt es ein fertiges Bild? `imageSeq` zählt jedes neue bzw. verworfene Bild (Vorschau nur bei Wechsel neu laden). */
  hasImage: boolean;
  imageSeq: number;
  /** Bildgrösse des Auftrags. */
  dims: { width: number; height: number };
  /** Eingebautes Cycles gefunden? `null` = Suche läuft noch. */
  cyclesOk: boolean | null;
  /** Gibt es einen Gastgeber für Blender (Tauri/Electron)? `null` = Suche läuft noch. */
  hasHost: boolean | null;
}

/** Bildschirmfertige Kamera zur Auswahl (Zeit als ms, damit der Zustand JSON-tauglich bleibt). */
export interface RenderCameraInfo {
  id: string;
  name: string;
  camera: RenderCameraSpec;
  sunWhenMs?: number;
}

/** Was die Einstellungen aus dem Projekt brauchen (kommt vom Hauptfenster; ändert sich mit dem Projekt). */
export interface RenderSetupInfo {
  defaultWhenMs: number;
  latLon: { lat: number; lon: number };
  cameras: RenderCameraInfo[];
  /** Voreinstellung der aktiven 3D-Ansicht; `null` = frei gedrehte Ansicht (Kamera des Viewports). */
  livePreset: RenderViewPreset | null;
  view: ActiveExportView;
  layouts: { id: string; name: string }[];
  defaultLayoutId: string;
  blenderPath: string;
}

/** Auftrag, wie die Oberfläche ihn schickt: nur Daten; Kamera und Ansicht löst das Hauptfenster erst beim Start auf. */
export interface RenderJobRequest {
  engine: RenderEngine;
  width: number;
  height: number;
  samples: number;
  denoise: boolean;
  whenMs: number;
  /** `live` = Kamera der aktiven 3D-Ansicht zum Zeitpunkt des Starts, sonst Id einer gespeicherten Kamera. */
  cameraKey: string;
  backfilled: boolean;
  context: boolean;
  exposureEv: number;
  /** Ansicht der aktiven 3D-Ansicht (Umbaufilter, Variante) übernehmen. */
  useView: boolean;
  renoColors: boolean;
  blenderPath: string;
}

/** Befehle der Oberfläche an den Auftrag (im Fenster über die Brücke, im Browser direkt). */
export interface RenderCommands {
  /** Bild rechnen (Cycles oder Blender, je `req.engine`). */
  start(req: RenderJobRequest): void;
  /** Statt eines Bildes die Szene als .blend speichern oder in Blender öffnen. */
  blend(kind: "save" | "open", req: RenderJobRequest): void;
  /** Browser: Blender-Paket als ZIP. */
  zip(req: RenderJobRequest): void;
  abort(): void;
  /** Zurück zu den Einstellungen (nach „Neu rendern“, beim Schliessen); verwirft das Bild. */
  reset(): void;
  savePng(): void;
  placeInLayout(layoutId: string): void;
}

/** Austauschbare Teile (Tests ersetzen sie). */
export interface RenderJobDeps {
  project(): Project;
  activeLevelId(): string;
  notify(text: string, kind: "info" | "warning" | "error"): void;
  cyclesAvailable(): Promise<boolean>;
  renderHost(): Promise<BlenderHost | null>;
  liveCamera(): RenderCameraSpec;
  activeView(): ActiveExportView;
  renderWithCycles: typeof renderWithCycles;
  buildPackage: typeof buildPackage;
  renderWithBlender: typeof renderWithBlender;
  saveBlendWithBlender: typeof saveBlendWithBlender;
  openInBlender: typeof openInBlender;
  packageAsZip: typeof packageAsZip;
  saveBinaryFile: typeof saveBinaryFile;
  /** Anonymitäts-Tor vor jeder Ausgabe. */
  gate(project: Project, names: string[], run: () => void | Promise<void>): void;
  placeImage(layoutId: string, name: string, png: Uint8Array): boolean;
  now(): number;
}

export const defaultRenderJobDeps: RenderJobDeps = {
  project: () => getState().project,
  activeLevelId: () => getState().activeLevelId,
  notify: (text, kind) => getState().notify(text, kind),
  cyclesAvailable,
  renderHost,
  liveCamera: () => currentRenderCamera(),
  activeView: activeExportView,
  renderWithCycles,
  buildPackage,
  renderWithBlender,
  saveBlendWithBlender,
  openInBlender,
  packageAsZip,
  saveBinaryFile,
  gate: runWithAnonymityGate,
  placeImage: placeImageOnLayout,
  now: () => Date.now(),
};

export const IDLE_RENDER_JOB: RenderJobState = {
  phase: "setup",
  job: "render",
  engine: "cycles",
  status: "",
  fraction: 0,
  message: "",
  lastLine: "",
  cyclesStatus: null,
  startedAt: 0,
  elapsedMs: 0,
  notice: null,
  hasImage: false,
  imageSeq: 0,
  dims: { width: 0, height: 0 },
  cyclesOk: null,
  hasHost: null,
};

/** Läuft gerade etwas (Paket bauen oder Prozess)? */
export const isRenderBusy = (s: Pick<RenderJobState, "phase">): boolean => s.phase === "preparing" || s.phase === "running";

const safeName = (project: Project): string => (exportProjectName(project) || "projekt").replace(/[^\w.-]+/g, "_");

/** Fortschrittsstufe des Blender-Skripts als Text. */
function stageText(e: { stage: string; done: number; total: number }): string {
  return e.stage === "render"
    ? t("render.stage.render", { done: e.done, total: e.total })
    : e.stage === "done"
      ? t("render.stage.done")
      : e.stage === "import" || e.stage === "materials" || e.stage === "camera" || e.stage === "sky" || e.stage === "organize" || e.stage === "save"
        ? t(`render.stage.${e.stage}`)
        : e.stage;
}

function cyclesStageText(s: CyclesStatus): string {
  return s.stage === "scene" ? t("render.working") : s.stage === "start" ? t("render.cycles.starting") : s.stage === "render" ? t("render.stage.render", { done: s.sample, total: s.samples }) : s.stage === "tonemap" ? t("render.cycles.tonemap") : t("render.stage.done");
}

/** Der eine Auftrag des Programms: Stand, Bild und Befehle. */
export class RenderJobController implements RenderCommands {
  private state: RenderJobState = IDLE_RENDER_JOB;
  private png: Uint8Array | null = null;
  private ac: AbortController | null = null;
  private host: BlenderHost | null = null;
  /** Zurücksetzen wurde während der Arbeit verlangt (Fenster zu): nach dem Ende nachholen. */
  private resetWhenIdle = false;
  private readonly listeners = new Set<() => void>();

  constructor(private deps: RenderJobDeps = defaultRenderJobDeps) {}

  /** Test-Naht (UI-Suite mit Ersatz-Renderer, `state/testHooks.ts`): einzelne Abhängigkeiten austauschen. */
  overrideDeps(over: Partial<RenderJobDeps>): void {
    this.deps = { ...this.deps, ...over };
  }

  getState = (): RenderJobState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  /** Das fertige Bild (PNG-Bytes) oder `null`. */
  getImage = (): Uint8Array | null => this.png;

  private patch(p: Partial<RenderJobState>): void {
    this.state = { ...this.state, ...p };
    for (const fn of [...this.listeners]) fn();
  }

  private setImage(png: Uint8Array | null): void {
    this.png = png;
    this.patch({ hasImage: png !== null, imageSeq: this.state.imageSeq + 1 });
  }

  /** Sucht das mitgelieferte Cycles und den Blender-Gastgeber (beim Öffnen der Oberfläche). */
  detectEnvironment(): void {
    this.patch({ cyclesOk: null, hasHost: null });
    void this.deps.cyclesAvailable().then(
      (ok) => this.patch({ cyclesOk: ok }),
      () => this.patch({ cyclesOk: false }),
    );
    void this.deps.renderHost().then(
      (h) => {
        this.host = h;
        this.patch({ hasHost: h !== null });
      },
      () => {
        this.host = null;
        this.patch({ hasHost: false });
      },
    );
  }

  /** Kamera, Ansicht und Zeit des Auftrags aus dem aktuellen Stand des Hauptfensters. */
  private resolve(req: RenderJobRequest) {
    const project = this.deps.project();
    const choice = req.cameraKey === "live" ? undefined : projectRenderCameras(project).find((c) => c.id === req.cameraKey);
    const camera = choice ? choice.camera : this.deps.liveCamera();
    const av = this.deps.activeView();
    const view: ExportView | undefined = req.useView && hasExportView(av.view) ? av.view : undefined;
    return { project, camera, view, when: new Date(req.whenMs) };
  }

  private begin(job: RenderJobKind, req: RenderJobRequest): AbortController {
    if (req.blenderPath !== getBlenderPath()) setBlenderPath(req.blenderPath);
    const ac = new AbortController();
    this.ac = ac;
    this.setImage(null);
    this.patch({
      phase: "preparing",
      job,
      engine: req.engine,
      status: t("render.working"),
      fraction: 0,
      message: "",
      lastLine: "",
      cyclesStatus: null,
      startedAt: this.deps.now(),
      elapsedMs: 0,
      notice: null,
      dims: { width: req.width, height: req.height },
    });
    return ac;
  }

  private failWith(err: unknown): void {
    if (err instanceof RenderCancelled || err instanceof CyclesCancelled) {
      this.patch({ phase: "setup", message: t("render.cancelled") });
    } else if (err instanceof BlenderMissingError) {
      this.patch({ phase: "missing" });
    } else if (err instanceof CyclesMissingError || err instanceof CyclesRenderError) {
      // Programm fehlt, Start gescheitert, Absturz, kein Bild: klare Meldung und als Hinweis im Hauptfenster.
      const text = err instanceof CyclesRenderError ? t(`render.cycles.error.${err.kind}`, { code: err.code, detail: err.detail }) : t("render.cycles.error.missing");
      this.patch({ phase: "error", message: text });
      this.deps.notify(text, "error");
    } else {
      this.patch({ phase: "error", message: t("render.error", { message: err instanceof Error ? err.message : String(err) }) });
    }
  }

  start = (req: RenderJobRequest): void => {
    if (isRenderBusy(this.state)) return;
    if (req.engine === "cycles") void this.runCycles(req);
    else void this.runBlender(req);
  };

  // [215] Bild mit dem eingebauten Cycles: Szene aus dem Kern, Programm mit Fortschritt/Abbruch, EXR → Tonwert → PNG.
  private async runCycles(req: RenderJobRequest): Promise<void> {
    const ac = this.begin("render", req);
    try {
      const { project, camera, view, when } = this.resolve(req);
      const cyc: CyclesRequest = {
        width: req.width,
        height: req.height,
        samples: req.samples,
        denoise: req.denoise,
        when,
        camera,
        backfilled: req.backfilled,
        context: req.context,
        extraEv: req.exposureEv,
        view,
        renovationColors: req.renoColors && !!view?.renovation,
      };
      const res = await this.deps.renderWithCycles(project, cyc, {
        signal: ac.signal,
        onMissingTextures: (n) => this.deps.notify(t("render.missingTextures", { n }), "warning"),
        onStatus: (s) => this.patch({ cyclesStatus: s, fraction: s.fraction, status: cyclesStageText(s), ...(s.stage !== "scene" ? { phase: "running" as const } : {}) }),
      });
      this.setImage(res.png);
      this.patch({ elapsedMs: res.millis, phase: "done" });
    } catch (err) {
      this.failWith(err);
    } finally {
      this.finish();
    }
  }

  private async runBlender(req: RenderJobRequest): Promise<void> {
    const ac = this.begin("render", req);
    try {
      const { project, camera, view, when } = this.resolve(req);
      const pkg = await this.deps.buildPackage(project, { width: req.width, height: req.height, samples: req.samples, when, camera, backfilled: req.backfilled, view });
      if (pkg.missingTextures.length > 0) this.deps.notify(t("render.missingTextures", { n: pkg.missingTextures.length }), "warning");
      const host = this.host ?? (await this.deps.renderHost());
      if (!host) throw new Error("kein Gastgeber");
      this.patch({ phase: "running", lastLine: "" });
      const res = await this.deps.renderWithBlender(host, pkg, {
        signal: ac.signal,
        onLine: (l) => this.patch({ lastLine: lastLineOf(l, this.state.lastLine) }),
        onProgress: (e) => this.patch({ fraction: e.fraction, status: stageText(e) }),
      });
      this.setImage(res.png);
      this.patch({ phase: "done" });
    } catch (err) {
      this.failWith(err);
    } finally {
      this.finish();
    }
  }

  // [228] Statt eines Bildes die Szene als Blender-Datei: speichern (nativer Dialog) oder direkt in Blender öffnen.
  blend = (kind: "save" | "open", req: RenderJobRequest): void => {
    if (isRenderBusy(this.state)) return;
    void this.runBlend(kind, req);
  };

  private async runBlend(kind: "save" | "open", req: RenderJobRequest): Promise<void> {
    const ac = this.begin(kind, req);
    try {
      const host = this.host ?? (await this.deps.renderHost());
      if (!host) throw new Error("kein Gastgeber");
      const { project, camera, view, when } = this.resolve(req);
      const pkg = await this.deps.buildPackage(project, { width: req.width, height: req.height, samples: req.samples, when, camera, backfilled: req.backfilled, view, mode: "save" });
      if (pkg.missingTextures.length > 0) this.deps.notify(t("render.missingTextures", { n: pkg.missingTextures.length }), "warning");
      this.patch({ phase: "running", lastLine: "" });
      const hooks = {
        signal: ac.signal,
        onLine: (l: string) => this.patch({ lastLine: lastLineOf(l, this.state.lastLine) }),
        onProgress: (e: { stage: string; done: number; total: number }) => this.patch({ status: stageText(e) }),
      };
      if (kind === "open") {
        await this.deps.openInBlender(host, pkg, hooks);
        this.deps.notify(t("render.blend.opened"), "info");
        this.patch({ phase: "setup", notice: t("render.blend.opened") });
      } else {
        const res = await this.deps.saveBlendWithBlender(host, pkg, hooks);
        const name = `${safeName(project)}.blend`;
        this.patch({ phase: "setup" });
        this.deps.gate(project, [name], async () => {
          if (await this.deps.saveBinaryFile(res.blend, name, "application/octet-stream")) {
            this.deps.notify(t("render.blend.saved"), "info");
            this.patch({ notice: t("render.blend.saved") });
          }
        });
      }
    } catch (err) {
      this.failWith(err);
    } finally {
      this.finish();
    }
  }

  /** Browser: Paket + Skript + Anleitung als ZIP (Blender läuft dort nicht von der Seite aus). */
  zip = (req: RenderJobRequest): void => {
    if (isRenderBusy(this.state)) return;
    void this.runZip(req);
  };

  private async runZip(req: RenderJobRequest): Promise<void> {
    this.begin("render", req);
    try {
      const { project, camera, view, when } = this.resolve(req);
      const pkg = await this.deps.buildPackage(project, { width: req.width, height: req.height, samples: req.samples, when, camera, backfilled: req.backfilled, view });
      const bytes = await this.deps.packageAsZip(pkg);
      const name = `${safeName(project)}-render.zip`;
      this.patch({ phase: "setup" });
      this.deps.gate(project, [name], async () => {
        if (await this.deps.saveBinaryFile(bytes, name, "application/zip")) {
          this.deps.notify(t("render.zip.saved"), "info");
          this.patch({ notice: t("render.zip.saved") });
        }
      });
    } catch (err) {
      this.patch({ phase: "error", message: t("render.error", { message: err instanceof Error ? err.message : String(err) }) });
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    this.ac = null;
    if (this.resetWhenIdle) this.reset();
  }

  abort = (): void => {
    this.ac?.abort();
  };

  reset = (): void => {
    if (isRenderBusy(this.state)) {
      this.resetWhenIdle = true;
      return;
    }
    this.resetWhenIdle = false;
    if (this.png) this.setImage(null);
    this.patch({ phase: "setup", message: "", notice: null, status: "", fraction: 0, cyclesStatus: null });
  };

  savePng = (): void => {
    const png = this.png;
    if (!png) return;
    const project = this.deps.project();
    const name = `${safeName(project)}-rendering.png`;
    this.deps.gate(project, [name], async () => {
      if (await this.deps.saveBinaryFile(png, name, "image/png")) {
        this.deps.notify(t("render.saved"), "info");
        this.patch({ notice: t("render.saved") });
      }
    });
  };

  // [208] Rendering als Bild aufs gewählte Blatt (mittig, Seitenverhältnis gehalten, volle Auflösung).
  placeInLayout = (layoutId: string): void => {
    const png = this.png;
    if (!png) return;
    const project = this.deps.project();
    const layout = (project.layouts ?? []).find((l) => l.id === layoutId);
    const name = `${safeName(project)}-rendering.png`;
    if (layout && this.deps.placeImage(layout.id, name, png)) {
      const text = t("render.toLayout.done", { name: layout.name });
      this.deps.notify(text, "info");
      this.patch({ notice: text });
    } else {
      this.deps.notify(t("render.toLayout.none"), "warning");
      this.patch({ notice: t("render.toLayout.none") });
    }
  };
}

function lastLineOf(line: string, prev: string): string {
  const v = line.trim();
  if (!v) return prev;
  return v.length > 160 ? `${v.slice(0, 157)}…` : v;
}

/** Der Auftrag des Programms (ein Rendering zur Zeit). */
export const renderJob = new RenderJobController();

/** Befehle an den Auftrag, als Objekt (Handler der Fenster-Brücke). */
export const renderCommands: RenderCommands = {
  start: renderJob.start,
  blend: renderJob.blend,
  zip: renderJob.zip,
  abort: renderJob.abort,
  reset: renderJob.reset,
  savePng: renderJob.savePng,
  placeInLayout: renderJob.placeInLayout,
};

/** React: Stand des Auftrags. */
export function useRenderJob(): RenderJobState {
  return useSyncExternalStore(renderJob.subscribe, renderJob.getState, renderJob.getState);
}

/** Einstellungs-Vorgaben aus dem aktuellen Projekt des Hauptfensters. */
export function buildRenderSetupInfo(deps: Pick<RenderJobDeps, "project" | "activeLevelId" | "activeView"> = defaultRenderJobDeps): RenderSetupInfo {
  const project = deps.project();
  const cams = projectRenderCameras(project).map((c) => {
    const info: RenderCameraInfo = { id: c.id, name: c.name, camera: c.camera };
    if (c.sunWhen) info.sunWhenMs = c.sunWhen.getTime();
    return info;
  });
  return {
    defaultWhenMs: defaultRenderTime(project).getTime(),
    latLon: projectLatLon(project),
    cameras: cams,
    livePreset: getCamera() ? null : presetForView3d(getState().view3d),
    view: deps.activeView(),
    layouts: (project.layouts ?? []).map((l) => ({ id: l.id, name: l.name })),
    defaultLayoutId: defaultTargetLayout(project, deps.activeLevelId())?.id ?? "",
    blenderPath: getBlenderPath(),
  };
}

/** Gleicher Inhalt: alte Referenz behalten (kein neuer Render, kein Senden an das Fenster). */
export const sameRenderSetupInfo = (a: RenderSetupInfo | null, b: RenderSetupInfo): boolean => a !== null && dataEqual(a, b);
