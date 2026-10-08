// Inhalt des „Frei"-Farbwahl-Bereichs — eine Bank-Leiste (mitgelieferte
// Paletten: Einfach/Tango/Material/RAL, dazu JEDE sichtbare eigene Palette
// als eigene Bank) + RGB/CMYK-Mischer für exakte Werte. Reiner Inhalt ohne
// Popover-Hülle (die bringt jeweils der Aufrufer mit) — genutzt vom
// „Frei"-Zweig in `PenColorField.tsx` UND von `PenSwatchPicker.tsx`
// (Stift-Farbdefinition im Stiftsatz-Tab).
//
// BEWUSST kein Dropdown hier drin: das Popover schliesst bei Aussenklick,
// und ein Dropdown rendert sein Menü in ein EIGENES Portal an `document.body`
// — ein Klick darin liegt damit ausserhalb des Popover-DOM und hat das
// Popover sofort mitgeschlossen (Nutzer-Report). Jede Palette ist deshalb
// eine eigene Bank in der Segmented-Leiste, ohne zweite Popover-Ebene.
//
// Verwaltung (anlegen/umbenennen/löschen/ein-/ausblenden, Farben entfernen)
// liegt NICHT hier, sondern im Ressourcen-Manager (`resourceManager/
// PalettesTab.tsx`) — hier gibt es nur Wählen + „aktuelle Farbe ablegen".
// Alle Projektdaten kommen als PROPS (kein Store-Zugriff): der Ressourcen-
// Manager läuft auch als eigenes natives Fenster ohne gemeinsamen Store.

import { useState } from "react";
import { FREE_COLOR_PALETTE } from "../model/penSets";
import { MATERIAL_PALETTE, RAL_CLASSIC, TANGO_PALETTE } from "../model/color";
import type { BuiltinPaletteBanks, CustomPalette } from "../model/types";
import { Swatch } from "./ColorSwatchCell";
import { ColorMixer } from "./ColorMixer";
import { Segmented } from "./resourceManager/fields";
import { t } from "../i18n";

export interface FreeColorPickerProps {
  color: string;
  onChange: (hex: string) => void;
  /** Eigene Paletten des Projekts; nur `visible !== false` erscheinen als Bank. */
  customPalettes?: CustomPalette[];
  /** Sichtbarkeit der mitgelieferten Bänke; fehlender Schlüssel = sichtbar. */
  builtinBanks?: BuiltinPaletteBanks;
  /** Legt die AKTUELLE Farbe in der angegebenen eigenen Palette ab („+"-Zelle). */
  onSaveColor?: (paletteId: string, hex: string) => void;
}

/** Eine Bank: fester Satz Farben (mitgeliefert) oder eine eigene Palette. */
interface Bank {
  id: string;
  label: string;
  entries: { hex: string; title: string }[];
  /** Gesetzt nur bei eigenen Paletten — schaltet die „+"-Zelle frei. */
  paletteId?: string;
  hint?: string;
}

export function FreeColorPicker({
  color,
  onChange,
  customPalettes,
  builtinBanks,
  onSaveColor,
}: FreeColorPickerProps) {
  const banks: Bank[] = [];
  if (builtinBanks?.simple !== false) {
    banks.push({
      id: "simple",
      label: t("pen.paletteSimple"),
      entries: FREE_COLOR_PALETTE.map((hex) => ({ hex, title: hex })),
    });
  }
  if (builtinBanks?.tango !== false) {
    banks.push({
      id: "tango",
      label: "Tango",
      entries: TANGO_PALETTE.map((c) => ({ hex: c.hex, title: c.name })),
    });
  }
  if (builtinBanks?.material !== false) {
    banks.push({
      id: "material",
      label: "Material",
      entries: MATERIAL_PALETTE.map((c) => ({ hex: c.hex, title: c.name })),
    });
  }
  if (builtinBanks?.ral !== false) {
    banks.push({
      id: "ral",
      label: "RAL",
      entries: RAL_CLASSIC.map((c) => ({ hex: c.hex, title: `RAL ${c.code} — ${c.name}` })),
      hint: t("pen.ralHint"),
    });
  }
  for (const p of customPalettes ?? []) {
    if (p.visible === false) continue;
    banks.push({
      id: `custom-${p.id}`,
      label: p.name,
      paletteId: p.id,
      entries: p.colors.map((hex) => ({ hex, title: hex })),
    });
  }

  const [bankId, setBankId] = useState<string>(banks[0]?.id ?? "");
  const active = banks.find((b) => b.id === bankId) ?? banks[0];

  return (
    <div className="free-color-picker">
      {banks.length > 1 && (
        <Segmented
          value={active?.id ?? ""}
          onChange={setBankId}
          options={banks.map((b) => ({ value: b.id, label: b.label }))}
        />
      )}
      {active && (
        <>
          <div className="pen-color-grid">
            {active.paletteId && onSaveColor && (
              <button
                type="button"
                className="pen-color-cell pen-color-cell-add"
                title={t("pen.saveColor")}
                onClick={() => onSaveColor(active.paletteId!, color)}
              >
                +
              </button>
            )}
            {active.entries.map((e) => (
              <Swatch
                key={`${active.id}-${e.hex}-${e.title}`}
                color={e.hex}
                active={e.hex.toLowerCase() === color.toLowerCase()}
                title={e.title}
                onClick={() => onChange(e.hex)}
              />
            ))}
          </div>
          {active.hint && <div className="pen-color-hint">{active.hint}</div>}
          {active.paletteId && active.entries.length === 0 && (
            <div className="pen-color-hint">{t("pen.customEmpty")}</div>
          )}
        </>
      )}
      <ColorMixer color={color} onChange={onChange} />
    </div>
  );
}
