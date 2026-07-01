// Schwebendes Dialog-Fenster zum Bearbeiten eines Rich-Text-Dokuments (Raum-
// Stempel / Textobjekt). Doppelklick auf einen Stempel öffnet es (nicht den
// Footer). Der Body ist der bestehende RichTextEditor (mit eigener Mini-Toolbar,
// hier ok, weil eigenes Fenster). „Übernehmen" schreibt das bearbeitete Dokument
// zurück, „Abbrechen" verwirft. Bezeichner englisch, UI-Text deutsch.

import { useState } from "react";
import { t } from "../i18n";
import { RichTextEditor } from "../text/RichTextEditor";
import type { RichTextDoc } from "../text/richText";

export interface TextEditorDialogProps {
  /** Ausgangsdokument (wird beim Öffnen kopiert; Editor arbeitet lokal). */
  value: RichTextDoc;
  /** „Übernehmen" — das bearbeitete Dokument zurückschreiben. */
  onApply: (doc: RichTextDoc) => void;
  /** „Abbrechen"/Schliessen — ohne Übernahme. */
  onCancel: () => void;
}

export function TextEditorDialog({ value, onApply, onCancel }: TextEditorDialogProps) {
  // Lokaler Arbeitszustand — erst „Übernehmen" schreibt zurück (echtes
  // Abbrechen möglich). Start = übergebenes Dokument.
  const [draft, setDraft] = useState<RichTextDoc>(value);

  return (
    <div
      className="texteditor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("text.editTitle")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="texteditor-dialog">
        <div className="texteditor-head">
          <span className="texteditor-title">{t("text.editTitle")}</span>
          <button
            type="button"
            className="texteditor-x"
            onClick={onCancel}
            title={t("text.cancel")}
            aria-label={t("text.cancel")}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </div>
        <div className="texteditor-body">
          <RichTextEditor value={draft} onChange={setDraft} autoFocus />
        </div>
        <div className="texteditor-foot">
          <button type="button" className="texteditor-btn" onClick={onCancel}>
            {t("text.cancel")}
          </button>
          <button
            type="button"
            className="texteditor-btn texteditor-btn-primary"
            onClick={() => onApply(draft)}
          >
            {t("text.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TextEditorDialog;
