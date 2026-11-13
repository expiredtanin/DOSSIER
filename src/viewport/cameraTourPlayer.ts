// [246] Abspielen der Kamerafahrt: ein Animationsbild nach dem anderen die Sicht aus `sampleTour` setzen. Kein React, kein
// Store — die Sicht kommt über `apply`, Zeit und Bildtakt sind austauschbar (Tests). Esc und Klick (Zeiger unten ausserhalb
// von `[data-tour-ui]`) brechen ab; die Kameras selbst ändern sich nie.

import { sampleToView, sampleTour, tourDuration, type TourKey, type TourMode } from "./cameraTour";
import type { ViewCamera } from "./cameraBridge";

export type TourEnd = "done" | "cancelled" | "failed";

export interface TourRunOptions {
  keys: readonly TourKey[];
  /** Sekunden je Abschnitt. */
  seconds: number;
  mode: TourMode;
  aspect?: number;
  /** Sicht setzen; false = nicht darstellbar (Viewport weg) → Fahrt endet mit "failed". */
  apply: (view: ViewCamera) => boolean;
  /** Fortschritt 0…1 und verstrichene Sekunden, je Bild. */
  onProgress?: (fraction: number, elapsed: number) => void;
  /** Esc/Klick abbrechen lassen (Vorgabe: ja, sobald `window` existiert). */
  cancelOnInput?: boolean;
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (h: number) => void;
}

export interface TourRun {
  /** Bricht ab (`finished` löst mit "cancelled" auf). Mehrfach aufrufbar. */
  cancel(): void;
  finished: Promise<TourEnd>;
}

/** Startet die Fahrt sofort; das erste Bild (Kamera 1) wird synchron gesetzt. */
export function runTour(o: TourRunOptions): TourRun {
  const now = o.now ?? (() => performance.now());
  const raf = o.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = o.caf ?? ((h) => cancelAnimationFrame(h));
  const total = tourDuration(o.keys.length, o.seconds);
  let handle = 0;
  let ended = false;
  let resolveEnd!: (e: TourEnd) => void;
  const finished = new Promise<TourEnd>((r) => (resolveEnd = r));
  const listeners: (() => void)[] = [];

  const end = (how: TourEnd) => {
    if (ended) return;
    ended = true;
    if (handle) caf(handle);
    listeners.forEach((off) => off());
    resolveEnd(how);
  };

  const frame = (elapsed: number): boolean => {
    const s = sampleTour(o.keys, o.seconds, o.mode, elapsed);
    const view = s ? sampleToView(s, o.aspect) : null;
    if (!view || !o.apply(view)) {
      end("failed");
      return false;
    }
    o.onProgress?.(total > 0 ? Math.min(1, elapsed / total) : 1, Math.min(elapsed, total));
    return true;
  };

  if (o.cancelOnInput !== false && typeof window !== "undefined") {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      end("cancelled");
    };
    const onPointer = (e: Event) => {
      const el = e.target as Element | null;
      if (el && typeof el.closest === "function" && el.closest("[data-tour-ui]")) return;
      end("cancelled");
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    listeners.push(
      () => window.removeEventListener("keydown", onKey, true),
      () => window.removeEventListener("pointerdown", onPointer, true),
    );
  }

  if (o.keys.length === 0) {
    end("failed");
  } else if (frame(0)) {
    if (total <= 0) end("done");
    else {
      const t0 = now();
      const step = () => {
        if (ended) return;
        const elapsed = (now() - t0) / 1000;
        if (!frame(elapsed)) return;
        if (elapsed >= total) end("done");
        else handle = raf(step);
      };
      handle = raf(step);
    }
  }
  return { cancel: () => end("cancelled"), finished };
}
