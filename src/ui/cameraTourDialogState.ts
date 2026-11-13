// [246] Zustand des Dialogs „Kamerafahrt": reiner Reducer (Phasen, Eingaben, Fortschritt), getrennt von React und Viewport,
// damit er sich testen lässt. Phasen: setup → running (Abspielen oder Aufnehmen) → done (nur nach Aufnahme) bzw. error.

import { TOUR_DEFAULT_SECONDS, clampSeconds, tourDuration, type TourMode } from "../viewport/cameraTour";
import type { VideoFormatId } from "../viewport/videoRecorder";

export type TourPhase = "setup" | "running" | "done" | "error";

/** Bildrate der Aufnahme (fest, Vorgabe laut [246]). */
export const TOUR_FPS = 30;

export interface TourDialogState {
  open: boolean;
  phase: TourPhase;
  /** Eingabe in Sekunden je Abschnitt (kann ungültig sein, solange getippt wird; `seconds` ist die gültige Fassung). */
  secondsText: string;
  mode: TourMode;
  format: VideoFormatId | null;
  /** Läuft gerade eine Aufnahme (statt nur Vorschau)? */
  recording: boolean;
  /** 0…1. */
  progress: number;
  /** Meldung (Fehler, Abbruch). */
  message: string;
  cameraCount: number;
}

export type TourDialogAction =
  | { type: "open"; cameraCount: number; seconds?: number; mode?: TourMode; formats: VideoFormatId[] }
  | { type: "close" }
  | { type: "seconds"; text: string }
  | { type: "mode"; mode: TourMode }
  | { type: "format"; format: VideoFormatId }
  | { type: "start"; recording: boolean }
  | { type: "progress"; fraction: number }
  | { type: "finish"; recording: boolean }
  | { type: "cancel" }
  | { type: "fail"; message: string }
  | { type: "again" };

export const initialTourDialogState: TourDialogState = {
  open: false,
  phase: "setup",
  secondsText: String(TOUR_DEFAULT_SECONDS),
  mode: "catmull",
  format: null,
  recording: false,
  progress: 0,
  message: "",
  cameraCount: 0,
};

/** Eingegebene Sekunden als Zahl (Komma erlaubt), `null` bei Unsinn oder ausserhalb 0,5 … 60. */
export function parseSeconds(text: string): number | null {
  const v = Number(text.trim().replace(",", "."));
  if (!text.trim() || !Number.isFinite(v)) return null;
  return v >= 0.5 && v <= 60 ? v : null;
}

/** Gültige Sekunden (geklemmt), auch bei halb getipptem Text. */
export function effectiveSeconds(s: TourDialogState): number {
  return parseSeconds(s.secondsText) ?? clampSeconds(Number(s.secondsText.replace(",", ".")));
}

/** Gesamtdauer der Fahrt in Sekunden. */
export function totalSeconds(s: TourDialogState): number {
  return tourDuration(s.cameraCount, effectiveSeconds(s));
}

/** Darf gestartet werden (mindestens eine Kamera, gültige Dauer, nicht schon laufend)? */
export function canStart(s: TourDialogState): boolean {
  return s.phase !== "running" && s.cameraCount >= 1 && parseSeconds(s.secondsText) !== null;
}

/** Darf aufgenommen werden (zusätzlich: ein Format gewählt, mindestens zwei Kameras)? */
export function canRecord(s: TourDialogState): boolean {
  return canStart(s) && s.format !== null && s.cameraCount >= 2;
}

export function tourDialogReducer(s: TourDialogState, a: TourDialogAction): TourDialogState {
  switch (a.type) {
    case "open":
      return {
        ...initialTourDialogState,
        open: true,
        cameraCount: a.cameraCount,
        secondsText: String(a.seconds ?? TOUR_DEFAULT_SECONDS),
        mode: a.mode ?? "catmull",
        format: a.formats[0] ?? null,
      };
    case "close":
      return s.phase === "running" ? s : { ...s, open: false, phase: "setup", message: "" };
    case "seconds":
      return { ...s, secondsText: a.text };
    case "mode":
      return { ...s, mode: a.mode };
    case "format":
      return { ...s, format: a.format };
    case "start":
      return canStart(s) ? { ...s, phase: "running", recording: a.recording, progress: 0, message: "" } : s;
    case "progress":
      return s.phase === "running" ? { ...s, progress: Math.min(1, Math.max(0, Number.isFinite(a.fraction) ? a.fraction : 0)) } : s;
    case "finish":
      return a.recording ? { ...s, phase: "done", recording: false, progress: 1 } : { ...s, phase: "setup", recording: false, progress: 0 };
    case "cancel":
      return { ...s, phase: "setup", recording: false, progress: 0 };
    case "fail":
      return { ...s, phase: "error", recording: false, progress: 0, message: a.message };
    case "again":
      return { ...s, phase: "setup", message: "", progress: 0 };
  }
}
