// Angebot, eine Autosave-Kopie wiederherzustellen (s. state/autosave.ts) — gleiches
// Overlay-Muster wie `UnsavedChangesDialog` (kein `window.confirm`, im Tauri-WKWebView
// wirkungslos). „Später" lässt die Kopie liegen; sie wird beim nächsten Start erneut angeboten.

import { useEffect } from "react";
import { t } from "../i18n";

export interface RecoverAutosaveDialogProps {
  /** Dateipfad der Kopie (null = nie gespeichertes Projekt). */
  path: string | null;
  savedAt: number;
  onRestore: () => void;
  onDiscard: () => void;
  onLater: () => void;
}

export function RecoverAutosaveDialog({ path, savedAt, onRestore, onDiscard, onLater }: RecoverAutosaveDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onLater();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onLater]);

  const when = new Date(savedAt).toLocaleString();
  const name = path ? path.split(/[\\/]/).pop() : t("recover.unsaved");

  return (
    <div className="imp-overlay recover-overlay" onClick={onLater}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("recover.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("recover.title")}</span>
          <button className="imp-close" onClick={onLater} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{t("recover.message", { name: name ?? "", when })}</div>
          </section>
        </div>
        <footer className="imp-foot">
          <button className="imp-btn" onClick={onLater}>
            {t("recover.later")}
          </button>
          <button className="imp-btn danger" onClick={onDiscard}>
            {t("recover.discard")}
          </button>
          <button className="imp-btn primary" onClick={onRestore}>
            {t("recover.restore")}
          </button>
        </footer>
      </div>
    </div>
  );
}
