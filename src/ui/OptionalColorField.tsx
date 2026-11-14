// Farbfeld mit „keine“ ([256], Klassen-Füllung): leerer Wert = nicht gesetzt (bisheriges Verhalten).
// Der Farbwähler ist das native `<input type="color">`; „keine“ setzt den Wert zurück.

import { t } from "../i18n";

export function OptionalColorField({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (hex: string | undefined) => void;
}) {
  return (
    <span className="attr-color" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <label className="attr-color-swatch-wrap" title={t("attr.pickColor")}>
        <span
          className="attr-color-swatch"
          style={value ? { background: value } : { background: "transparent", outline: "1px dashed var(--muted)" }}
        />
        <input type="color" value={value ?? "#d9d9d9"} onChange={(e) => onChange(e.target.value)} />
      </label>
      <button type="button" disabled={!value} onClick={() => onChange(undefined)}>
        {t("editor.fillNone")}
      </button>
    </span>
  );
}
