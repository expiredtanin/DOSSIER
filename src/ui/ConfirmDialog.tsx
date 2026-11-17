// Allgemeine Rückfrage als Overlay-Dialog (Ersatz für `window.confirm`, im Tauri-WKWebView stumm). Muster wie
// `PromptDialog`: abgedunkeltes Overlay, Klick daneben und Esc schliessen. Gerendert im Body-Portal, damit Panels mit
// eigener Überlagerung ihn nicht beschneiden.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { useModalFocus } from "./modalFocus";

export interface ConfirmDialogProps {
  title: string;
  message: string;
  /** Beschriftung des bestätigenden Knopfs (z. B. „Löschen“). */
  confirmLabel: string;
  /** Riskante Aktion: bestätigender Knopf mit roter Kontur. */
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onClose }: ConfirmDialogProps) {
  const dialogRef = useModalFocus({});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="imp-overlay" onClick={onClose}>
      <div className="imp-dialog" ref={dialogRef} role="alertdialog" aria-modal="true" aria-label={title} data-testid="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">{title}</span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body">
          <section className="imp-section">{message}</section>
        </div>
        <footer className="imp-foot">
          <button className="imp-btn" onClick={onClose}>
            {t("export.cancel")}
          </button>
          <button className={`imp-btn ${danger ? "danger" : "primary"}`} data-autofocus data-testid="confirm-dialog-ok" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
