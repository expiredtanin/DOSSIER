// Tab „Textstile" (Text Styles) — benannte Marks-Vorlagen (Schriftart/-grösse/
// fett/kursiv/unterstrichen/Farbe), die über die Text-Formatier-Gruppe der
// Oberleiste auf eine Auswahl/ein ganzes Textelement angewendet werden
// (`applyPreset()`, `text/richText.ts` — bereits vorhandene Anwendungslogik,
// hier nur die Bibliothek selbst editierbar gemacht). Master-Detail-Layout wie
// die übrigen Ressourcen-Tabs.
//
// Bewusst NICHT live verknüpft: ein Textelement trägt KEINE `textStyleId`, die
// nachträgliche Stil-Änderungen automatisch nachzieht — „Anwenden" kopiert die
// Marks-Werte einmalig in die Auswahl (wie ein Word-Schnellformat, nicht wie
// eine live gebundene Absatzvorlage). Eine echte Live-Kopplung wäre dieselbe
// Architektur-Frage wie „Bemassung assoziativ" (eigenes PENDENZEN-Item) und
// hätte die Rendering-Resolution-Order angefasst — bewusst nicht mitgelöst.

import { useState } from "react";
import type { TextStylePreset } from "../../text/richText";
import { TEXT_FONTS } from "../TopBar";
import { t } from "../../i18n";
import { ColorField, DeleteButton, FieldRow, NumberField, SelectField } from "./fields";

const DEFAULT_COLOR = "#1a1a1a";
const NO_FONT = "__default__";

/** Detail-Panel EINES Textstils (rechte Seite des Master-Detail-Layouts). */
function TextStyleDetail({
  style,
  onPatch,
  onDelete,
}: {
  style: TextStylePreset;
  onPatch: (patch: Partial<TextStylePreset>) => void;
  onDelete: () => void;
}) {
  const m = style.marks;
  const patchMarks = (part: Partial<TextStylePreset["marks"]>) =>
    onPatch({ marks: { ...m, ...part } });

  return (
    <div className="res-md-detail-inner">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={style.label}
          placeholder={t("resources.textStyles.placeholder")}
          onChange={(e) => onPatch({ label: e.target.value })}
        />
        <DeleteButton
          onClick={onDelete}
          title={t("resources.delete.textStyle", { name: style.label })}
        />
      </div>

      <div className="res-md-preview">
        <span
          style={{
            fontFamily: m.font || undefined,
            fontWeight: m.bold ? 700 : 400,
            fontStyle: m.italic ? "italic" : "normal",
            textDecoration: m.underline ? "underline" : undefined,
            color: m.color ?? DEFAULT_COLOR,
            fontSize: `${Math.max(8, Math.min(32, m.sizePt ?? 10))}px`,
          }}
        >
          {t("resources.textStyles.previewText")}
        </span>
      </div>

      <div className="res-fields">
        <FieldRow label={t("resources.field.font")}>
          <SelectField
            value={m.font ?? NO_FONT}
            onChange={(v) => patchMarks({ font: v === NO_FONT ? undefined : v })}
            options={[
              { value: NO_FONT, label: t("resources.textStyles.defaultFont") },
              ...TEXT_FONTS.map((f) => ({ value: f, label: f })),
            ]}
          />
        </FieldRow>
        <FieldRow label={t("resources.field.size")}>
          <NumberField value={m.sizePt ?? 10} onChange={(sizePt) => patchMarks({ sizePt })} step={1} min={1} />
        </FieldRow>
        <FieldRow label={t("resources.col.color")}>
          <ColorField color={m.color ?? DEFAULT_COLOR} onChange={(color) => patchMarks({ color })} />
        </FieldRow>
        <FieldRow label={t("resources.field.bold")}>
          <input type="checkbox" checked={!!m.bold} onChange={(e) => patchMarks({ bold: e.target.checked })} />
        </FieldRow>
        <FieldRow label={t("resources.field.italic")}>
          <input type="checkbox" checked={!!m.italic} onChange={(e) => patchMarks({ italic: e.target.checked })} />
        </FieldRow>
        <FieldRow label={t("resources.field.underline")}>
          <input
            type="checkbox"
            checked={!!m.underline}
            onChange={(e) => patchMarks({ underline: e.target.checked })}
          />
        </FieldRow>
      </div>
    </div>
  );
}

export function TextStylesTab({
  styles,
  onPatchTextStyle,
  onAddTextStyle,
  onDeleteTextStyle,
}: {
  styles: TextStylePreset[];
  onPatchTextStyle: (id: string, patch: Partial<TextStylePreset>) => void;
  onAddTextStyle: () => void;
  onDeleteTextStyle: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = styles.find((s) => s.id === selectedId) ?? styles[0];

  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.textStyles.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {styles.map((s) => (
            <button
              key={s.id}
              className={`res-md-row${selected?.id === s.id ? " active" : ""}`}
              onClick={() => setSelectedId(s.id)}
            >
              <span
                className="res-md-row-name"
                style={{
                  fontWeight: s.marks.bold ? 700 : 400,
                  fontStyle: s.marks.italic ? "italic" : "normal",
                }}
              >
                {s.label}
              </span>
            </button>
          ))}
          {styles.length === 0 && <div className="res-md-empty">{t("resources.textStyles.empty")}</div>}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={() => onAddTextStyle()}>
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <TextStyleDetail
              key={selected.id}
              style={selected}
              onPatch={(patch) => onPatchTextStyle(selected.id, patch)}
              onDelete={() => onDeleteTextStyle(selected.id)}
            />
          ) : (
            <div className="res-md-empty">{t("resources.textStyles.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
