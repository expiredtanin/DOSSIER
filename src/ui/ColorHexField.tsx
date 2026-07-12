// Farbfeld: nur der quadratische Swatch (öffnet die native Farbpalette per
// Klick) — bewusst OHNE separates Hex-Textfeld daneben (Nutzer-Wunsch: in den
// Attributen soll generell nur das Quadrat sichtbar sein, keine zwei Felder).

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
    </span>
  );
}
