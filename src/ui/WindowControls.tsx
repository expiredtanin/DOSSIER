// Eigene Fenstersteuerung (Minimieren/Maximieren/Schliessen) für das randlose
// Electron-Fenster (frame:false, s. scripts/electron-main.cjs) — ohne native
// Titelleiste gibt es sonst keine Möglichkeit, das Fenster zu steuern.
//
// Rendert NUR, wenn `window.dossierWindow` existiert (vom Preload-Skript
// injiziert) — also nur unter Electron. In Tauri (native Fensterdekoration)
// und im Browser-Dev-Modus (?vite) bleibt die Komponente unsichtbar (`null`),
// dort steuert das Betriebssystem bzw. der Browser das Fenster.

import { useEffect, useState } from "react";

/** Von electron-preload.cjs via contextBridge injiziert (nur unter Electron). */
interface DossierWindowApi {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
}

declare global {
  interface Window {
    dossierWindow?: DossierWindowApi;
  }
}

export function WindowControls() {
  const api = window.dossierWindow;
  const [maximized, setMaximized] = useState(false);

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

  return (
    <div className="win-controls" role="group" aria-label="Fenster">
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
    </div>
  );
}
