// [246] Kamerafahrt: Aktionen am Store und am Viewport. Abspielen (Sicht je Bild über `setCamera`, Kameras bleiben
// unberührt — kein Op) und Aufnehmen (`MediaRecorder` auf dem 3D-Canvas, ohne Server). Die reine Interpolation steht in
// `viewport/cameraTour.ts`, der Bildtakt in `viewport/cameraTourPlayer.ts`, die Aufnahme in `viewport/videoRecorder.ts`.
// Unter Tauri/WKWebView kann `MediaRecorder` auf dem Canvas fehlen: dann `notify`, kein Absturz.

import { t } from "../i18n";
import { TOUR_DEFAULT_SECONDS, clampSeconds, tourKeys, type TourKey, type TourMode } from "../viewport/cameraTour";
import { getCamera, getViewportCanvas, setCamera, viewportAvailable } from "../viewport/cameraBridge";
import { runTour, type TourEnd, type TourRun } from "../viewport/cameraTourPlayer";
import { canRecordCanvas, startRecording, type VideoFormat } from "../viewport/videoRecorder";
import { getState } from "./appStore";
import { whenViewportReady } from "./cameraActions";
import { switchViewType } from "./tabNavigation";

export interface TourSettings {
  /** Sekunden je Abschnitt (Vorgabe 4). */
  seconds: number;
  mode: TourMode;
}

let settings: TourSettings = { seconds: TOUR_DEFAULT_SECONDS, mode: "catmull" };
let active: TourRun | null = null;

export const getTourSettings = (): TourSettings => ({ ...settings });
export function setTourSettings(next: Partial<TourSettings>): void {
  settings = { seconds: clampSeconds(next.seconds ?? settings.seconds), mode: next.mode ?? settings.mode };
}

/** Stützpunkte der Fahrt: die Kameras des Projekts in Listenreihenfolge. */
export function currentTourKeys(): TourKey[] {
  const p = getState().project;
  return tourKeys(p, p.cameras ?? []);
}

export const isCameraTourRunning = (): boolean => active !== null;

/** Bricht eine laufende Fahrt ab (Abspielen oder Aufnahme). */
export function cancelCameraTour(): void {
  active?.cancel();
}

export type TourResult = { status: "done" | "cancelled" | "failed" | "unavailable" | "unsupported" };

async function prepare(minKeys: number): Promise<TourKey[] | null> {
  const st = getState();
  if (active) return null;
  const keys = currentTourKeys();
  if (keys.length < minKeys) {
    st.notify(t(minKeys > 1 ? "tour.needTwo" : "tour.needCamera"), "warning");
    return null;
  }
  if (!viewportAvailable()) switchViewType("perspektive");
  if (!(await whenViewportReady())) {
    st.notify(t("camera.noViewport"), "warning");
    return null;
  }
  return keys;
}

function startRun(keys: TourKey[], onProgress?: (fraction: number) => void): TourRun {
  const aspect = getCamera()?.aspect ?? 16 / 9;
  const { seconds, mode } = settings;
  const run = runTour({
    keys,
    seconds,
    mode,
    aspect,
    apply: (view) => setCamera(view, { animate: false }),
    ...(onProgress ? { onProgress: (f: number) => onProgress(f) } : {}),
  });
  active = run;
  void run.finished.then(() => {
    if (active === run) active = null;
  });
  return run;
}

/** Fahrt im 3D-Viewport abspielen. Esc oder Klick bricht ab. */
export async function playCameraTour(onProgress?: (fraction: number) => void): Promise<TourResult> {
  const keys = await prepare(1);
  if (!keys) return { status: "unavailable" };
  const end: TourEnd = await startRun(keys, onProgress).finished;
  return { status: end };
}

/**
 * Fahrt abspielen und dabei den 3D-Canvas aufnehmen. Bei Erfolg `blob` (Video im gewählten Format); sonst Status ohne
 * Blob (abgebrochen, nicht unterstützt, fehlgeschlagen). Meldungen über `notify`.
 */
export async function recordCameraTour(
  format: VideoFormat,
  fps: number,
  onProgress?: (fraction: number) => void,
): Promise<TourResult & { blob?: Blob }> {
  const keys = await prepare(2);
  if (!keys) return { status: "unavailable" };
  const st = getState();
  const canvas = getViewportCanvas();
  if (!canRecordCanvas(canvas)) {
    st.notify(t("tour.noRecorder"), "warning");
    return { status: "unsupported" };
  }
  let rec;
  try {
    rec = startRecording(canvas!, { fps, format, bitsPerSecond: 8_000_000 });
  } catch (err) {
    st.notify(t("tour.recordFailed", { reason: err instanceof Error ? err.message : String(err) }), "warning");
    return { status: "unsupported" };
  }
  const end = await startRun(keys, onProgress).finished;
  if (end !== "done") {
    rec.cancel();
    if (end === "failed") st.notify(t("camera.noViewport"), "warning");
    return { status: end };
  }
  // Das letzte Bild kurz stehen lassen, damit es im Video vorkommt.
  await new Promise((r) => setTimeout(r, 400));
  try {
    return { status: "done", blob: await rec.stop() };
  } catch (err) {
    st.notify(t("tour.recordFailed", { reason: err instanceof Error ? err.message : String(err) }), "warning");
    return { status: "failed" };
  }
}
