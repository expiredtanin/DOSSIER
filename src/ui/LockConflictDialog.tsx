// Meldung, wenn eine Projektdatei bereits in einer anderen Instanz gesperrt ist
// (Lock-Konflikt, s. src/io/projectFile.ts acquireProjectLock). Ersetzt
// `window.confirm` (im Tauri-WKWebView deaktiviert) — gleiches Overlay-Muster
// wie PromptDialog (imp-overlay/imp-dialog/imp-head/imp-body/imp-foot/imp-btn).

import { useEffect } from "react";
import { t } from "../i18n";
import type { LockInfo } from "../native/projectFile";

export interface LockConflictDialogProps {
  /** Info aus der Lock-Sidecar-Datei (pid/hostname/timestamp) — kann fehlen. */
  info: LockInfo | null;
  /** Projekt ohne Lock nur lesend öffnen (kein Schreibzugriff-Anspruch). */
  onReadOnly: () => void;
  /** Lock ignorieren und trotzdem schreibend öffnen (Risiko: zwei Schreiber). */
  onForceOpen: () => void;
  onCancel: () => void;
}

export function LockConflictDialog({
  info,
  onReadOnly,
  onForceOpen,
  onCancel,
}: LockConflictDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="imp-overlay" onClick={onCancel}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("lock.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("lock.title")}</span>
          <button className="imp-close" onClick={onCancel} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{t("lock.message")}</div>
            {info && (
              <div className="imp-section-title" style={{ opacity: 0.7, fontWeight: 400 }}>
                {t("lock.messageInfo", { host: info.hostname, pid: String(info.pid) })}
              </div>
            )}
          </section>
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={onCancel}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn danger" onClick={onForceOpen} title={t("lock.forceOpenWarning")}>
            {t("lock.forceOpen")}
          </button>
          <button className="imp-btn primary" onClick={onReadOnly}>
            {t("lock.openReadOnly")}
          </button>
        </footer>
      </div>
    </div>
  );
}
