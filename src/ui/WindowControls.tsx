// Eigene Fenstersteuerung (Minimieren/Maximieren/Schliessen) für das RANDLOSE
// Fenster — sowohl Electron (frame:false, s. scripts/electron-main.cjs) ALS AUCH
// Tauri (decorations:false, s. tauri.conf.json). Ohne native Titelleiste gibt es
// sonst keine Möglichkeit, das Fenster zu steuern.
//
// Rendert NUR, wenn eine Fenster-API vorhanden ist: unter Electron
// `window.dossierWindow` (Preload), unter Tauri `getCurrentWindow()`
// (@tauri-apps/api/window, dynamisch geladen wie in nativeSync.ts). Im reinen
// Browser-Dev-Modus (?vite) bleibt die Komponente unsichtbar (`null`) — dort
// steuert der Browser das Fenster. Die Tauri-Permissions liegen in
// src-tauri/capabilities/default.json (core:window:allow-minimize/…/close).

import { useEffect, useState } from "react";

/** Gemeinsame, minimale Fenster-API (Electron-Preload ODER Tauri-Adapter). */
interface WindowApi {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  /** Abo auf Maximiert-Wechsel; liefert eine Abmelde-Funktion. */
  onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
}

declare global {
  interface Window {
    dossierWindow?: WindowApi;
  }
}

/** Tauri-Laufzeit erkannt (analog nativeSync.ts). */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function WindowControls() {
  const [api, setApi] = useState<WindowApi | null>(null);
  const [maximized, setMaximized] = useState(false);

  // Passende Fenster-API einmalig auflösen: Electron synchron, Tauri asynchron
  // (dynamischer Import, damit Browser-/Build-Pfad ohne @tauri-apps grün bleibt).
  useEffect(() => {
    if (window.dossierWindow) {
      setApi(window.dossierWindow);
      return;
    }
    if (!isTauri()) return;
    let disposed = false;
    import(/* @vite-ignore */ "@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (disposed) return;
        const w = getCurrentWindow();
        setApi({
          minimize: () => void w.minimize(),
          toggleMaximize: () => void w.toggleMaximize(),
          close: () => void w.close(),
          isMaximized: () => w.isMaximized(),
          onMaximizedChange: (cb) => {
            // Bei jeder Größenänderung den Maximiert-Zustand neu melden.
            const unlisten = w.onResized(() => {
              void w.isMaximized().then(cb);
            });
            return () => void unlisten.then((fn) => fn());
          },
        });
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.isMaximized().then((v) => {
      if (!cancelled) setMaximized(v);
    });
    const unsubscribe = api.onMaximizedChange((v) => setMaximized(v));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  if (!api) return null;

  // Reihenfolge (macOS-Titelleiste links): Schliessen · Minimieren · Maximieren.
  return (
    <div className="win-controls" role="group" aria-label="Fenster">
      <button
        type="button"
        className="win-btn win-btn-close"
        onClick={() => api.close()}
        title="Schliessen"
        aria-label="Schliessen"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M1 1 L9 9 M9 1 L1 9"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button
        type="button"
        className="win-btn"
        onClick={() => api.minimize()}
        title="Minimieren"
        aria-label="Minimieren"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5 L9 5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button
        type="button"
        className="win-btn"
        onClick={() => api.toggleMaximize()}
        title={maximized ? "Wiederherstellen" : "Maximieren"}
        aria-label={maximized ? "Wiederherstellen" : "Maximieren"}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M2.5 1.5 H8.5 V7.5 H2.5 Z M2.5 1.5 V3 M1.5 3 H2.5 M1.5 3 V9 H7.5 V7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect
              x="1.5"
              y="1.5"
              width="7"
              height="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        )}
      </button>
    </div>
  );
}
