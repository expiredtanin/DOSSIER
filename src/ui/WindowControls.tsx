// Eigene Fenstersteuerung (Minimieren/Maximieren/Schliessen) für das randlose
// ELECTRON-Fenster (frame:false, s. scripts/electron-main.cjs) — dort gibt es
// ohne native Titelleiste sonst keine Fenstersteuerung.
//
// Unter TAURI werden die NATIVEN macOS-Ampeln verwendet (tauri.conf.json:
// titleBarStyle "Overlay" + hiddenTitle, native Dekoration mit gerundeten Ecken),
// daher rendert diese Komponente dort NICHT (kein `window.dossierWindow`) — sonst
// gäbe es doppelte Knöpfe. Im Browser-Dev-Modus ebenfalls unsichtbar (`null`).

import { useEffect, useState } from "react";
import { t } from "../i18n";

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

  // Reihenfolge (macOS-Titelleiste links): Schliessen · Minimieren · Maximieren.
  return (
    <div className="win-controls" role="group" aria-label={t("window.controls")}>
      <button
        type="button"
        className="win-btn win-btn-close"
        onClick={() => api.close()}
        title={t("window.close")}
        aria-label={t("window.close")}
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
        title={t("window.minimize")}
        aria-label={t("window.minimize")}
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
