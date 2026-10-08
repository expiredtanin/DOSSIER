// Meldung vor Neu/Öffnen, wenn das aktuelle Projekt ungespeicherte Änderungen
// hat (bisher wurde stillschweigend überschrieben — Bug-Meldung). Gleiches
// Overlay-Muster wie `LockConflictDialog` (kein `window.confirm`, im Tauri-
// WKWebView deaktiviert).

import { useEffect, useState } from "react";
import { t } from "../i18n";

export interface UnsavedChangesDialogProps {
  /** Speichert das aktuelle Projekt; liefert `true` nur bei echtem Erfolg
   *  (nicht bei abgebrochenem nativem Speichern-Dialog). */
  onSave: () => Promise<boolean>;
  /** Änderungen verwerfen und mit der eigentlichen Aktion (Neu/Öffnen) fortfahren. */
  onDiscard: () => void;
  onCancel: () => void;
}

export function UnsavedChangesDialog({ onSave, onDiscard, onCancel }: UnsavedChangesDialogProps) {
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const handleSave = async () => {
    setSaving(true);
    const saved = await onSave();
    setSaving(false);
    // Abgebrochener nativer Dialog ⇒ NICHT verwerfen (sicherer Fallback,
    // gleichwertig zu "Abbrechen" statt stillen Datenverlust).
    if (saved) onDiscard();
  };

  return (
    <div className="imp-overlay" onClick={onCancel}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("unsaved.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("unsaved.title")}</span>
          <button className="imp-close" onClick={onCancel} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{t("unsaved.message")}</div>
          </section>
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={onCancel} disabled={saving}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn danger" onClick={onDiscard} disabled={saving}>
            {t("unsaved.discard")}
          </button>
          <button className="imp-btn primary" onClick={handleSave} disabled={saving}>
            {t("unsaved.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}
