// Schwebender Dialog zum Bearbeiten des strukturierten Raum-Stempels (Feldmodell):
// Raumnummer, Raumname (+ Zeile 2), Bodenfläche (mit Präfix) und Nutzung. Jede
// Zeile trägt zusätzlich eine eigene Ausrichtung (links/mitte/rechts). Ersetzt
// für neue Räume den freien Text-Editor. Kontrolliert (value/onApply/onCancel);
// arbeitet auf einem lokalen Entwurf, erst „Übernehmen" schreibt zurück.
// Bezeichner englisch, UI-Text über t().
//
// Folge-Arbeit: Zeilen-Layout-Editor (welches Feld auf welche Zeile),
// Per-Feld-Typografie, Fensterfläche.

import { useState } from "react";
import { t } from "../i18n";
import type { RoomStamp } from "../model/types";
import type { Align } from "../text/richText";

export interface RoomStampEditorProps {
  /** Ausgangsstempel (wird beim Öffnen kopiert; Editor arbeitet lokal). */
  value: RoomStamp;
  /** „Übernehmen" — den bearbeiteten Stempel zurückschreiben. */
  onApply: (stamp: RoomStamp) => void;
  /** „Abbrechen"/Schliessen — ohne Übernahme. */
  onCancel: () => void;
}

/** Die drei Ausrichtungen mit Icon und Beschriftung (für die Umschalter). */
const ALIGN_CELLS: { align: Align; icon: string; titleKey: string }[] = [
  { align: "left", icon: "format_align_left", titleKey: "text.align.left" },
  { align: "center", icon: "format_align_center", titleKey: "text.align.center" },
  { align: "right", icon: "format_align_right", titleKey: "text.align.right" },
];

/**
 * Drei-Wege-Umschalter für die Zeilen-Ausrichtung. `value` ist der aktuelle Wert
 * (fehlt er, gilt `fallback`); `onChange` liefert die gewählte Ausrichtung.
 */
function AlignToggle({
  value,
  fallback,
  onChange,
  disabled,
  label,
}: {
  value: Align | undefined;
  fallback: Align;
  onChange: (align: Align) => void;
  disabled?: boolean;
  label: string;
}) {
  const current = value ?? fallback;
  return (
    <div className="roomstamp-align" role="group" aria-label={label}>
      {ALIGN_CELLS.map((cell) => (
        <button
          key={cell.align}
          type="button"
          className={`roomstamp-align-btn${current === cell.align ? " active" : ""}`}
          disabled={disabled}
          aria-pressed={current === cell.align}
          title={t(cell.titleKey)}
          aria-label={t(cell.titleKey)}
          onClick={() => onChange(cell.align)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {cell.icon}
          </span>
        </button>
      ))}
    </div>
  );
}

export function RoomStampEditor({ value, onApply, onCancel }: RoomStampEditorProps) {
  const [draft, setDraft] = useState<RoomStamp>(value);

  const patch = (p: Partial<RoomStamp>) => setDraft((d) => ({ ...d, ...p }));

  const hasLine2 = (draft.nameLine2 ?? "").trim().length > 0;

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

          <div className="roomstamp-row">
            <label className="roomstamp-field">
              <span className="roomstamp-label">{t("roomStamp.name")}</span>
              <input
                type="text"
                className="roomstamp-input"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </label>
            <AlignToggle
              value={draft.nameAlign}
              fallback="left"
              label={`${t("roomStamp.name")} — ${t("text.group")}`}
              onChange={(nameAlign) => patch({ nameAlign })}
            />
          </div>

          <div className="roomstamp-row">
            <label className="roomstamp-field">
              <span className="roomstamp-label">{t("roomStamp.nameLine2")}</span>
              <input
                type="text"
                className="roomstamp-input"
                value={draft.nameLine2 ?? ""}
                onChange={(e) => patch({ nameLine2: e.target.value })}
              />
            </label>
            <AlignToggle
              value={draft.line2Align}
              fallback="left"
              disabled={!hasLine2}
              label={`${t("roomStamp.nameLine2")} — ${t("text.group")}`}
              onChange={(line2Align) => patch({ line2Align })}
            />
          </div>

          <div className="roomstamp-row">
            <label className="roomstamp-check">
              <input
                type="checkbox"
                checked={draft.showFloorArea}
                onChange={(e) => patch({ showFloorArea: e.target.checked })}
              />
              <span>{t("roomStamp.showFloorArea")}</span>
            </label>
            <AlignToggle
              value={draft.floorAreaAlign}
              fallback="center"
              disabled={!draft.showFloorArea}
              label={`${t("roomStamp.showFloorArea")} — ${t("text.group")}`}
              onChange={(floorAreaAlign) => patch({ floorAreaAlign })}
            />
          </div>

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

          <div className="roomstamp-row">
            <label className="roomstamp-check">
              <input
                type="checkbox"
                checked={draft.showUsage}
                onChange={(e) => patch({ showUsage: e.target.checked })}
              />
              <span>{t("roomStamp.showUsage")}</span>
            </label>
            <AlignToggle
              value={draft.usageAlign}
              fallback="center"
              disabled={!draft.showUsage}
              label={`${t("roomStamp.showUsage")} — ${t("text.group")}`}
              onChange={(usageAlign) => patch({ usageAlign })}
            />
          </div>
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
