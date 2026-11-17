// [215] Rendering mit dem eingebauten Cycles aus dem Dialog „Rendering …“ (`ui/RenderDialog.tsx`): Szene über den Kern schreiben
// (`export/cyclesRender.ts`), Programm über die Fassade `native/cyclesRuntime.ts` laufen lassen (Fortschritt, Abbruch), EXR → Tonwert → PNG,
// Arbeitsordner immer aufräumen. Alles ohne Oberfläche und mit austauschbaren Abhängigkeiten (`CyclesDeps`), damit vitest die Pfade
// (Vorgaben, Fortschritt, Abbruch, Fehler) mit einem Ersatz-`runCycles` prüft.

import {
  CyclesCancelled,
  CyclesMissingError,
  buildCyclesPackage,
  exrToPng,
  readExr,
  type Codec,
  type CyclesPackage,
  type CyclesSceneOptions,
  type RenderCameraSpec,
} from "../core";
import type { Project } from "../model/types";
import { pakoCodec } from "../export/zlibCodec";
import { cleanupCyclesScene, cyclesAvailable, prepareCyclesScene, readCyclesFile, runCycles, type CyclesProgress, type CyclesResult } from "../native/cyclesRuntime";
import { loadTextureBytes } from "./renderAction";

export type RenderEngine = "cycles" | "blender";

/** Qualitätsstufen für Cycles (Samples); „Final“ gibt es nur für Blender. */
export const CYCLES_QUALITIES = [
  { id: "draft", samples: 32 },
  { id: "normal", samples: 128 },
  { id: "high", samples: 512 },
] as const;
export type CyclesQualityId = (typeof CYCLES_QUALITIES)[number]["id"];

/** Längste Bildkante für Cycles (EXR und Tonwert laufen im Speicher der App: A2 bei 300 dpi = 7016 px passt). */
export const CYCLES_MAX_EDGE = 8192;

/** Höchste Zahl eigener Samples im Dialog. */
export const CYCLES_MAX_SAMPLES = 4096;

/** Vorgabe der Engine: das eingebaute Cycles, wenn es da ist; sonst Blender. */
export function defaultEngine(cyclesOk: boolean): RenderEngine {
  return cyclesOk ? "cycles" : "blender";
}

/** Samples zu einer Qualitätsstufe (unbekannt oder „final“ → Hoch bzw. Normal). */
export function cyclesSamples(quality: string): number {
  const q = CYCLES_QUALITIES.find((c) => c.id === quality);
  if (q) return q.samples;
  return quality === "final" ? CYCLES_QUALITIES[2].samples : CYCLES_QUALITIES[1].samples;
}

/** Zeitspanne als `m:ss` bzw. `h:mm:ss`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Fortschritt für die Anzeige: Phase, Sample n/N, verstrichene Zeit und geschätzte Restzeit (null, solange sie sich nicht schätzen lässt). */
export interface CyclesStatus {
  stage: "scene" | "start" | "render" | "tonemap" | "done";
  fraction: number;
  sample: number;
  samples: number;
  elapsedMs: number;
  etaMs: number | null;
}

/**
 * Restzeit aus dem Takt der Samples: Zeit seit dem ersten gemeldeten Sample geteilt durch die seither fertigen Samples, mal die
 * Samples, die noch fehlen. Das erste Sample enthält das Übersetzen der Kernel (Mac/Metal, Minuten) und zählt nicht mit.
 * Vor dem zweiten gemeldeten Sample: null.
 */
export function estimateEtaMs(firstAtMs: number, firstSample: number, nowMs: number, sample: number, samples: number): number | null {
  const done = sample - firstSample;
  if (done < 1 || nowMs <= firstAtMs) return null;
  return ((nowMs - firstAtMs) / done) * Math.max(0, samples - sample);
}

/** Fehlerarten für die Meldung im Dialog (Text über `t("render.cycles.error.<kind>")`). */
export type CyclesFailureKind = "start" | "crashed" | "nofile" | "empty";

export class CyclesRenderError extends Error {
  constructor(
    readonly kind: CyclesFailureKind,
    /** Programmcode (`crashed`, `nofile`). */
    readonly code: number,
    /** Letzte Fehler-/Ausgabezeilen des Programms bzw. Meldung des gescheiterten Starts. */
    readonly detail: string,
  ) {
    super(`${kind}: ${detail || code}`);
    this.name = "CyclesRenderError";
  }
}

export interface CyclesRequest {
  width: number;
  height: number;
  samples: number;
  denoise: boolean;
  when: Date;
  camera: RenderCameraSpec;
  backfilled: boolean;
  /** Gelände und Umgebung. */
  context: boolean;
  /** Belichtung in EV; `undefined` = automatisch nach Sonnenhöhe. */
  exposureEv?: number;
  /** Belichtungskorrektur in EV beim Tonwert, auf die automatische Belichtung (0 = keine). */
  extraEv?: number;
}

export interface CyclesHooks {
  onStatus?: (s: CyclesStatus) => void;
  signal?: AbortSignal;
  /** Bildkarten, die nicht geladen werden konnten (Material erscheint einfarbig). */
  onMissingTextures?: (n: number) => void;
}

/** Austauschbare Teile (Tests ersetzen sie). */
export interface CyclesDeps {
  available(): Promise<boolean>;
  buildPackage(project: Project, opts: CyclesSceneOptions): Promise<CyclesPackage>;
  prepare(files: { path: string; bytes: Uint8Array }[]): Promise<string>;
  run(dir: string, args: string[], onProgress: (p: CyclesProgress) => void, signal?: AbortSignal): Promise<CyclesResult>;
  read(path: string): Promise<Uint8Array>;
  cleanup(dir: string): Promise<void>;
  codec: Codec;
  now(): number;
}

export const defaultCyclesDeps: CyclesDeps = {
  available: cyclesAvailable,
  buildPackage: (project, opts) => buildCyclesPackage(project, opts, loadTextureBytes),
  prepare: prepareCyclesScene,
  run: runCycles,
  read: readCyclesFile,
  cleanup: cleanupCyclesScene,
  codec: pakoCodec,
  now: () => Date.now(),
};

/** Kommandozeile: Pfade relativ zum Arbeitsordner (der Hauptprozess prüft sie), Ausgabe als lineares EXR. */
export function cyclesRunArgs(req: Pick<CyclesRequest, "width" | "height" | "samples">): string[] {
  return ["--background", "--samples", String(req.samples), "--width", String(req.width), "--height", String(req.height), "--output", "render.exr", "scene.xml"];
}

export interface CyclesImage {
  png: Uint8Array;
  width: number;
  height: number;
  millis: number;
}

/** Die letzten Fehlerzeilen des Programms (`… | ERROR: …`), sonst die letzten Zeilen, höchstens drei, zu einem Text. */
export function errorLines(lines: string[]): string {
  const errors = lines.filter((l) => /\bERROR\b|DOSSIER_ERROR|\bFATAL\b/i.test(l));
  const pick = (errors.length > 0 ? errors : lines).map((l) => l.trim()).filter(Boolean);
  return pick.slice(-3).join(" | ").slice(0, 400);
}

/**
 * Bild mit Cycles rechnen. Wirft {@link CyclesMissingError} (Programm fehlt), {@link CyclesCancelled} (Abbruch) oder
 * {@link CyclesRenderError} (Start gescheitert, Programm abgestürzt, kein Bild, leeres Modell). Der Arbeitsordner wird in jedem Fall gelöscht.
 */
export async function renderWithCycles(project: Project, req: CyclesRequest, hooks: CyclesHooks = {}, deps: CyclesDeps = defaultCyclesDeps): Promise<CyclesImage> {
  const t0 = deps.now();
  const status = (s: Omit<CyclesStatus, "elapsedMs" | "etaMs"> & { etaMs?: number | null }): void => hooks.onStatus?.({ etaMs: null, ...s, elapsedMs: deps.now() - t0 });
  const blank = { fraction: 0, sample: 0, samples: req.samples };
  if (hooks.signal?.aborted) throw new CyclesCancelled();
  if (!(await deps.available())) throw new CyclesMissingError();

  status({ stage: "scene", ...blank });
  const pkg = await deps.buildPackage(project, {
    width: req.width,
    height: req.height,
    samples: req.samples,
    denoise: req.denoise,
    whenMs: req.when.getTime(),
    camera: req.camera,
    backfilled: req.backfilled,
    context: req.context,
    exposureEv: req.exposureEv,
  });
  if (pkg.info.meshes === 0) throw new CyclesRenderError("empty", 0, "");
  if (pkg.missingTextures.length > 0) hooks.onMissingTextures?.(pkg.missingTextures.length);
  if (hooks.signal?.aborted) throw new CyclesCancelled();

  const dir = await deps.prepare(pkg.files);
  try {
    status({ stage: "start", ...blank });
    let first: { at: number; sample: number } | null = null;
    let res: CyclesResult;
    try {
      res = await deps.run(
        dir,
        cyclesRunArgs(req),
        (p) => {
          const now = deps.now();
          if (!first) first = { at: now, sample: p.sample };
          status({ stage: "render", fraction: p.fraction, sample: p.sample, samples: p.samples, etaMs: estimateEtaMs(first.at, first.sample, now, p.sample, p.samples) });
        },
        hooks.signal,
      );
    } catch (e) {
      if (e instanceof CyclesMissingError) throw e;
      throw new CyclesRenderError("start", -1, e instanceof Error ? e.message : String(e));
    }
    if (res.cancelled || hooks.signal?.aborted) throw new CyclesCancelled();
    const detail = errorLines(res.lines);
    if (res.code !== 0) throw new CyclesRenderError("crashed", res.code, detail);
    const exr = await deps.read(`${dir}/render.exr`).catch(() => null);
    if (!exr || exr.length === 0) throw new CyclesRenderError("nofile", res.code, detail);

    status({ stage: "tonemap", fraction: 1, sample: req.samples, samples: req.samples });
    const img = readExr(exr, deps.codec.inflate);
    const png = exrToPng(img, "filmic", Number.isFinite(req.extraEv) ? req.extraEv! : 0, deps.codec.deflate);
    status({ stage: "done", fraction: 1, sample: req.samples, samples: req.samples });
    return { png, width: img.width, height: img.height, millis: deps.now() - t0 };
  } finally {
    await deps.cleanup(dir).catch(() => undefined);
  }
}
