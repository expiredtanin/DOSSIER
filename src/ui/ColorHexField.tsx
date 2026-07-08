// Farbfeld: Swatch (öffnet die native Farbpalette) + separat editierbarer
// Hex-Code (Tippen/Enter übernimmt, Esc verwirft). Ersetzt die frühere reine
// Text-Anzeige des Hex-Werts, die nicht anklickbar/editierbar war.

import { useEffect, useState } from "react";
import { t } from "../i18n";

export function ColorHexField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value.toUpperCase());

  // Extern geänderter Wert (z. B. Preset-Klick) synchron halten, solange das
  // Feld nicht gerade selbst bearbeitet wird (kein Cursor-Sprung beim Tippen).
  useEffect(() => setText(value.toUpperCase()), [value]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    if (/^#[0-9a-fA-F]{6}$/.test(withHash)) {
      onChange(withHash.toLowerCase());
      setText(withHash.toUpperCase());
    } else {
      setText(value.toUpperCase()); // ungültig → letzten gültigen Wert zeigen
    }
  };

  return (
    <span className="attr-color">
      <label className="attr-color-swatch-wrap" title={t("attr.pickColor")}>
        <span className="attr-color-swatch" style={{ background: value }} />
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <input
        type="text"
        className="attr-color-hex attr-color-hex-input"
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setText(value.toUpperCase());
            e.currentTarget.blur();
          }
        }}
      />
    </span>
  );
}
