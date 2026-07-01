// Schwebender Dialog zum Bearbeiten des strukturierten Raum-Stempels (Feldmodell):
// Raumnummer, Raumname (+ Zeile 2), Bodenfläche (mit Präfix) und Nutzung. Ersetzt
// für neue Räume den freien Text-Editor. Kontrolliert (value/onApply/onCancel);
// arbeitet auf einem lokalen Entwurf, erst „Übernehmen" schreibt zurück.
// Bezeichner englisch, UI-Text über t().
//
// Folge-Arbeit: Zeilen-Layout-Editor (welches Feld auf welche Zeile),
// Per-Feld-Typografie, Fensterfläche.

import { useState } from "react";
import { t } from "../i18n";
import type { RoomStamp } from "../model/types";

export interface RoomStampEditorProps {
  /** Ausgangsstempel (wird beim Öffnen kopiert; Editor arbeitet lokal). */
  value: RoomStamp;
  /** „Übernehmen" — den bearbeiteten Stempel zurückschreiben. */
  onApply: (stamp: RoomStamp) => void;
  /** „Abbrechen"/Schliessen — ohne Übernahme. */
  onCancel: () => void;
}

export function RoomStampEditor({ value, onApply, onCancel }: RoomStampEditorProps) {
  const [draft, setDraft] = useState<RoomStamp>(value);

  const patch = (p: Partial<RoomStamp>) => setDraft((d) => ({ ...d, ...p }));

  return (
    <div
      className="texteditor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("roomStamp.title")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="texteditor-dialog roomstamp-dialog">
        <div className="texteditor-head">
          <span className="texteditor-title">{t("roomStamp.title")}</span>
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

        <div className="texteditor-body roomstamp-body">
          <label className="roomstamp-field">
            <span className="roomstamp-label">{t("roomStamp.number")}</span>
            <input
              type="text"
              className="roomstamp-input"
              value={draft.number ?? ""}
              onChange={(e) => patch({ number: e.target.value })}
              autoFocus
            />
          </label>

          <label className="roomstamp-field">
            <span className="roomstamp-label">{t("roomStamp.name")}</span>
            <input
              type="text"
              className="roomstamp-input"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>

          <label className="roomstamp-field">
            <span className="roomstamp-label">{t("roomStamp.nameLine2")}</span>
            <input
              type="text"
              className="roomstamp-input"
              value={draft.nameLine2 ?? ""}
              onChange={(e) => patch({ nameLine2: e.target.value })}
            />
          </label>

          <label className="roomstamp-check">
            <input
              type="checkbox"
              checked={draft.showFloorArea}
              onChange={(e) => patch({ showFloorArea: e.target.checked })}
            />
            <span>{t("roomStamp.showFloorArea")}</span>
          </label>

          <label className="roomstamp-field">
            <span className="roomstamp-label">{t("roomStamp.floorAreaPrefix")}</span>
            <input
              type="text"
              className="roomstamp-input"
              value={draft.floorAreaPrefix ?? ""}
              disabled={!draft.showFloorArea}
              onChange={(e) => patch({ floorAreaPrefix: e.target.value })}
            />
          </label>

          <label className="roomstamp-check">
            <input
              type="checkbox"
              checked={draft.showUsage}
              onChange={(e) => patch({ showUsage: e.target.checked })}
            />
            <span>{t("roomStamp.showUsage")}</span>
          </label>
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

export default RoomStampEditor;
