// Tab „Treppentypen" — Tragart, Stufenausbildung, Geländer und Laufbreite.
// Nutzt den generischen {@link TypeLibraryTab}-Rumpf (siehe dort).

import type { Project, StairType } from "../../model/types";
import { t } from "../../i18n";
import { FieldRow, NumberField, SelectField } from "./fields";
import { TypeLibraryTab } from "./TypeLibraryTab";

const STAIR_STRUCTURE_OPTIONS: { value: StairType["structure"]; labelKey: string }[] = [
  { value: "massiv", labelKey: "resources.structure.massiv" },
  { value: "beton", labelKey: "resources.structure.beton" },
  { value: "wange", labelKey: "resources.structure.wange" },
  { value: "aufgesattelt", labelKey: "resources.structure.aufgesattelt" },
  { value: "spindel", labelKey: "resources.structure.spindel" },
];

const STAIR_RAILING_OPTIONS: { value: NonNullable<StairType["railing"]>; labelKey: string }[] = [
  { value: "keine", labelKey: "resources.railing.keine" },
  { value: "links", labelKey: "resources.railing.links" },
  { value: "rechts", labelKey: "resources.railing.rechts" },
  { value: "beide", labelKey: "resources.railing.beide" },
];

export function StairStylesTab({
  project,
  onAddStairType,
  onPatchStairType,
  onDeleteStairType,
}: {
  project: Project;
  onAddStairType?: () => void;
  onPatchStairType?: (id: string, patch: Partial<StairType>) => void;
  onDeleteStairType?: (id: string) => void;
}) {
  return (
    <TypeLibraryTab
      types={project.stairTypes ?? []}
      hintKey="resources.stairTypes.hint"
      emptyKey="resources.stairTypes.empty"
      placeholderKey="resources.stairTypes.placeholder"
      deleteKeyPrefix="resources.delete.stairType"
      onAdd={onAddStairType}
      onPatch={onPatchStairType}
      onDelete={onDeleteStairType}
      renderFields={(stair, patch) => (
        <>
          <FieldRow label={t("resources.field.structure")}>
            <SelectField
              value={stair.structure}
              onChange={(structure) => patch({ structure })}
              options={STAIR_STRUCTURE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.closedRisers")}>
            <input
              type="checkbox"
              checked={!!stair.closedRisers}
              onChange={(e) => patch({ closedRisers: e.target.checked })}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.treadThickness")}>
            <NumberField
              value={stair.treadThickness}
              onChange={(treadThickness) => patch({ treadThickness })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.nosing")}>
            <NumberField
              value={stair.nosing ?? 0}
              onChange={(nosing) => patch({ nosing })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.railing")}>
            <SelectField
              value={stair.railing ?? "keine"}
              onChange={(railing) => patch({ railing })}
              options={STAIR_RAILING_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.stairWidth")}>
            <NumberField
              value={stair.defaultWidth}
              onChange={(defaultWidth) => patch({ defaultWidth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
        </>
      )}
    />
  );
}
