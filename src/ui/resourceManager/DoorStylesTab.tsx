// Tab „Türtypen" — Bauart, Blattausführung/-zahl, Zarge und Standardmaße.
// Nutzt den generischen {@link TypeLibraryTab}-Rumpf (siehe dort).

import type { DoorType, Project } from "../../model/types";
import { t } from "../../i18n";
import { FieldRow, NumberField, Segmented, SelectField } from "./fields";
import { INSET_FACE_OPTIONS, TypeLibraryTab } from "./TypeLibraryTab";

const DOOR_KIND_OPTIONS: { value: DoorType["kind"]; labelKey: string }[] = [
  { value: "dreh", labelKey: "resources.doorKind.dreh" },
  { value: "schiebe", labelKey: "resources.doorKind.schiebe" },
  { value: "wandoeffnung", labelKey: "resources.doorKind.wandoeffnung" },
];

const DOOR_LEAF_STYLE_OPTIONS: { value: DoorType["leafStyle"]; labelKey: string }[] = [
  { value: "glatt", labelKey: "resources.leafStyle.glatt" },
  { value: "kassette", labelKey: "resources.leafStyle.kassette" },
  { value: "glas", labelKey: "resources.leafStyle.glas" },
];

const DOOR_FRAME_KIND_OPTIONS: { value: NonNullable<DoorType["frameKind"]>; labelKey: string }[] = [
  { value: "zarge", labelKey: "resources.frameKind.zarge" },
  { value: "blockrahmen", labelKey: "resources.frameKind.blockrahmen" },
];

export function DoorStylesTab({
  project,
  onAddDoorType,
  onPatchDoorType,
  onDeleteDoorType,
}: {
  project: Project;
  onAddDoorType?: () => void;
  onPatchDoorType?: (id: string, patch: Partial<DoorType>) => void;
  onDeleteDoorType?: (id: string) => void;
}) {
  return (
    <TypeLibraryTab
      types={project.doorTypes ?? []}
      hintKey="resources.doorTypes.hint"
      emptyKey="resources.doorTypes.empty"
      placeholderKey="resources.doorTypes.placeholder"
      deleteKeyPrefix="resources.delete.doorType"
      onAdd={onAddDoorType}
      onPatch={onPatchDoorType}
      onDelete={onDeleteDoorType}
      renderFields={(door, patch) => (
        <>
          <FieldRow label={t("resources.field.doorKind")}>
            <SelectField
              value={door.kind}
              onChange={(kind) => patch({ kind })}
              options={DOOR_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.leafCount")}>
            <Segmented
              value={String(door.leafCount)}
              onChange={(v) => patch({ leafCount: (v === "2" ? 2 : 1) as 1 | 2 })}
              options={[
                { value: "1", label: t("resources.leafCount.1") },
                { value: "2", label: t("resources.leafCount.2") },
              ]}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.leafStyle")}>
            <SelectField
              value={door.leafStyle}
              onChange={(leafStyle) => patch({ leafStyle })}
              options={DOOR_LEAF_STYLE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          {door.leafStyle === "glas" && (
            <FieldRow label={t("resources.field.glazingRatio")}>
              <NumberField
                value={door.glazingRatio ?? 0.6}
                onChange={(glazingRatio) => patch({ glazingRatio })}
                step={0.01}
                min={0}
                max={1}
              />
            </FieldRow>
          )}
          <FieldRow label={t("resources.field.frameThickness")}>
            <NumberField
              value={door.frameThickness}
              onChange={(frameThickness) => patch({ frameThickness })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameDepth")}>
            <NumberField
              value={door.frameDepth ?? 0}
              onChange={(frameDepth) => patch({ frameDepth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameKind")}>
            <SelectField
              value={door.frameKind ?? "zarge"}
              onChange={(frameKind) => patch({ frameKind })}
              options={DOOR_FRAME_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameWidth")}>
            <NumberField
              value={door.frameWidth ?? 0.06}
              onChange={(frameWidth) => patch({ frameWidth })}
              step={0.005}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.insetFromFace")}>
            <NumberField
              value={door.insetFromFace ?? 0}
              onChange={(insetFromFace) => patch({ insetFromFace })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          {(door.insetFromFace ?? 0) > 0 && (
            <FieldRow label={t("resources.field.insetFace")}>
              <SelectField
                value={door.insetFace ?? "aussen"}
                onChange={(insetFace) => patch({ insetFace })}
                options={INSET_FACE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              />
            </FieldRow>
          )}
          <FieldRow label={t("resources.field.transomHeight")}>
            <NumberField
              value={door.transomHeight ?? 0}
              onChange={(transomHeight) => patch({ transomHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultWidth")}>
            <NumberField
              value={door.defaultWidth}
              onChange={(defaultWidth) => patch({ defaultWidth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultHeight")}>
            <NumberField
              value={door.defaultHeight}
              onChange={(defaultHeight) => patch({ defaultHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.threshold")}>
            <input
              type="checkbox"
              checked={!!door.threshold}
              onChange={(e) => patch({ threshold: e.target.checked })}
            />
          </FieldRow>
        </>
      )}
    />
  );
}
