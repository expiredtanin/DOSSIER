// Angebot „Vorige Fassung (.obp~) öffnen" ([116]): die gewählte Projektdatei liess sich nicht laden, ihre Sicherung
// aus dem vorletzten Speichern schon. Overlay-Dialog wie `RecoverAutosaveDialog` (kein `window.confirm`).

import { useEffect } from "react";
import { t } from "../i18n";
import { useModalFocus } from "./modalFocus";

export interface BackupOfferDialogProps {
  /** Pfad der Projektdatei, die sich nicht laden liess. */
  path: string;
  /** Fehlermeldung beim Laden. */
  error: string;
  onAccept: () => void;
  onCancel: () => void;
}

export function BackupOfferDialog({ path, error, onAccept, onCancel }: BackupOfferDialogProps) {
  const dialogRef = useModalFocus({});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const name = path.split(/[\\/]/).pop() ?? path;

  return (
    <div className="imp-overlay recover-overlay" onClick={onCancel}>
      <div
        className="imp-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("backup.offer.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("backup.offer.title")}</span>
          <button className="imp-close" onClick={onCancel} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{t("backup.offer.message", { name, error })}</div>
          </section>
        </div>
        <footer className="imp-foot">
          <button className="imp-btn" onClick={onCancel}>
            {t("backup.offer.cancel")}
          </button>
          <button className="imp-btn primary" onClick={onAccept}>
            {t("backup.offer.accept")}
          </button>
        </footer>
      </div>
    </div>
  );
}
