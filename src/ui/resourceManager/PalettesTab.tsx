// Tab „Paletten" — verwaltet, WELCHE Farbpaletten im Farbwahl-Popover
// (`ui/FreeColorPicker.tsx`) erscheinen und pflegt die eigenen Paletten.
// Bewusste Aufgabenteilung (Nutzer-Vorgabe): das Popover ist nur zum WÄHLEN
// da (plus „aktuelle Farbe ablegen"), die Verwaltung — anlegen, umbenennen,
// löschen, ein-/ausblenden, einzelne Farben entfernen — passiert hier.
//
// Prop-getrieben wie die übrigen Tabs (KEIN direkter Store-Zugriff): der
// Ressourcen-Manager läuft auch als eigenes natives Fenster, das seinen
// `project` per Event-Sync bekommt und Mutationen über die Handler-Brücke
// zurückschickt (s. `native/ResourceWindowApp.tsx`).

import { useState } from "react";
import type { BuiltinPaletteBank, Project } from "../../model/types";
import { MATERIAL_PALETTE, RAL_CLASSIC, TANGO_PALETTE } from "../../model/color";
import { freeColorPalette } from "../../model/penSets";
import { t } from "../../i18n";
import { DeleteButton, EmptyState, FieldRow, TextField } from "./fields";

/**
 * Die vier mitgelieferten Bänke. `labelKey` statt fertigem Label, damit `t()`
 * erst zur RENDERZEIT läuft (Sprachwechsel wirkt sonst nicht — gleiche
 * Konvention wie `PATTERN_OPTIONS` in `HatchesTab.tsx`); Eigennamen
 * (Tango/Material/RAL) stehen direkt in `label`. Eine Funktion, weil die Freie-Farbe-Palette aus dem
 * Kern kommt (erst nach `initCore()` lesbar).
 */
const builtinBanks = (): {
  id: BuiltinPaletteBank;
  label?: string;
  labelKey?: string;
  preview: string[];
}[] => [
  { id: "simple", labelKey: "pen.paletteSimple", preview: freeColorPalette() },
  { id: "tango", label: "Tango", preview: TANGO_PALETTE.map((c) => c.hex) },
  { id: "material", label: "Material", preview: MATERIAL_PALETTE.map((c) => c.hex) },
  { id: "ral", label: "RAL Classic", preview: RAL_CLASSIC.map((c) => c.hex) },
];

/** Kleiner Farbstreifen als Vorschau einer Bank/Palette (erste paar Farben). */
function PaletteStrip({ colors }: { colors: string[] }) {
  return (
    <span className="palette-strip">
      {colors.slice(0, 12).map((hex, i) => (
        <span key={`${hex}-${i}`} className="palette-strip-dot" style={{ background: hex }} />
      ))}
    </span>
  );
}

export function PalettesTab({
  project,
  onAddCustomPalette,
  onRenameCustomPalette,
  onDeleteCustomPalette,
  onRemoveColorFromCustomPalette,
  onSetCustomPaletteVisible,
  onSetBuiltinPaletteVisible,
}: {
  project: Project;
  onAddCustomPalette?: () => void;
  onRenameCustomPalette?: (id: string, name: string) => void;
  onDeleteCustomPalette?: (id: string) => void;
  onRemoveColorFromCustomPalette?: (paletteId: string, hex: string) => void;
  onSetCustomPaletteVisible?: (id: string, visible: boolean) => void;
  onSetBuiltinPaletteVisible?: (bank: BuiltinPaletteBank, visible: boolean) => void;
}) {
  const palettes = project.customPalettes ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = palettes.find((p) => p.id === selectedId) ?? palettes[0];

  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.palettes.hint")}</div>

      {/* Mitgelieferte Bänke: nur ein/aus — Inhalt ist fest. */}
      <div className="res-fields">
        <div className="res-section-label">{t("resources.palettes.builtin")}</div>
        {builtinBanks().map((bank) => (
          <FieldRow
            key={bank.id}
            label={bank.label ?? t(bank.labelKey!)}
            hint={t("resources.palettes.countHint", { count: bank.preview.length })}
          >
            <div className="palette-row">
              <input
                type="checkbox"
                checked={project.builtinPaletteBanks?.[bank.id] ?? true}
                onChange={(e) => onSetBuiltinPaletteVisible?.(bank.id, e.target.checked)}
              />
              <PaletteStrip colors={bank.preview} />
            </div>
          </FieldRow>
        ))}
      </div>

      {/* Eigene Paletten: Master-Detail wie die übrigen Ressourcen-Tabs. */}
      <div className="res-section-label">{t("resources.palettes.custom")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {palettes.map((p) => (
            <button
              key={p.id}
              className={`res-md-row${selected?.id === p.id ? " active" : ""}`}
              onClick={() => setSelectedId(p.id)}
            >
              <span className="res-md-row-name">{p.name}</span>
              <span className="res-md-row-meta">{p.colors.length}</span>
            </button>
          ))}
          {palettes.length === 0 && <div className="res-md-empty">{t("resources.palettes.empty")}</div>}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={() => onAddCustomPalette?.()}>
              <span className="res-add-plus">+</span> {t("resources.palettes.add")}
            </button>
          </div>
        </div>

        <div className="res-md-detail">
          {selected ? (
            <div className="res-md-detail-inner">
              <div className="res-md-head">
                <TextField
                  value={selected.name}
                  onChange={(name) => onRenameCustomPalette?.(selected.id, name)}
                  placeholder={t("resources.palettes.placeholder")}
                />
                <DeleteButton
                  onClick={() => onDeleteCustomPalette?.(selected.id)}
                  title={t("resources.delete.customPalette", { name: selected.name })}
                />
              </div>

              <div className="res-fields">
                <FieldRow label={t("resources.palettes.visible")} hint={t("resources.palettes.visible.hint")}>
                  <input
                    type="checkbox"
                    checked={selected.visible ?? true}
                    onChange={(e) => onSetCustomPaletteVisible?.(selected.id, e.target.checked)}
                  />
                </FieldRow>
              </div>

              {selected.colors.length > 0 ? (
                <div className="palette-colors">
                  {selected.colors.map((hex) => (
                    <div className="palette-color-row" key={hex}>
                      <span className="palette-color-swatch" style={{ background: hex }} />
                      <span className="palette-color-hex mono">{hex}</span>
                      <DeleteButton
                        onClick={() => onRemoveColorFromCustomPalette?.(selected.id, hex)}
                        title={t("pen.removeColor")}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState text={t("resources.palettes.noColors")} />
              )}
            </div>
          ) : (
            <div className="res-md-empty">{t("resources.palettes.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
