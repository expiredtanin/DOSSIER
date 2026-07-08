// Generischer Text-Eingabe-Dialog — ersetzt `window.prompt` überall im Code.
// GRUND: `window.prompt`/`window.confirm` sind im Tauri-WKWebView deaktiviert
// (liefern sofort `null` zurück) — jede Stelle, die sie nutzt, war in der
// Desktop-App faktisch kaputt (kein Name kam je an). Dieser Dialog ist der
// einheitliche Ersatz: gleiches Muster wie ExportSaveDialog/SettingsDialog
// (abgedunkeltes Overlay, Klick auf Hintergrund + Esc schliessen), Enter
// bestätigt. Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useState } from "react";
import { t } from "../i18n";

export interface PromptDialogProps {
  /** Kopfzeile des Dialogs. */
  title: string;
  /** Feld-Beschriftung/Frage (entspricht dem früheren `window.prompt`-Text). */
  label: string;
  /** Vorbelegter Wert (entspricht dem früheren zweiten `window.prompt`-Arg). */
  defaultValue?: string;
  /** Eingabetyp — "text" (Default) oder "number" für reine Zahlen-Prompts. */
  type?: "text" | "number";
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export function PromptDialog({
  title,
  label,
  defaultValue = "",
  type = "text",
  onConfirm,
  onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const commit = () => {
    const v = value.trim();
    if (v) onConfirm(v);
  };

  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{title}</span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{label}</div>
            <input
              className="settings-num-input"
              type={type}
              autoFocus
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
            />
          </section>
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={onClose}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn primary" onClick={commit}>
            {t("export.confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}
