// Tab „Fenstertypen" — Öffnungsart, Flügelzahl, Verglasung, Zarge, Brüstung.
// Nutzt den generischen {@link TypeLibraryTab}-Rumpf (siehe dort).

import type { Project, WindowType } from "../../model/types";
import { t } from "../../i18n";
import { FieldRow, NumberField, SelectField } from "./fields";
import { INSET_FACE_OPTIONS, TypeLibraryTab } from "./TypeLibraryTab";

const WINDOW_KIND_OPTIONS: { value: WindowType["kind"]; labelKey: string }[] = [
  { value: "dreh", labelKey: "resources.windowKind.dreh" },
  { value: "kipp", labelKey: "resources.windowKind.kipp" },
  { value: "drehkipp", labelKey: "resources.windowKind.drehkipp" },
  { value: "fest", labelKey: "resources.windowKind.fest" },
  { value: "schiebe", labelKey: "resources.windowKind.schiebe" },
];

const WINDOW_GLAZING_OPTIONS: { value: WindowType["glazing"]; labelKey: string }[] = [
  { value: "einfach", labelKey: "resources.glazing.einfach" },
  { value: "zweifach", labelKey: "resources.glazing.zweifach" },
  { value: "dreifach", labelKey: "resources.glazing.dreifach" },
];

const WINDOW_SILL_BOARD_OPTIONS: { value: NonNullable<WindowType["sillBoard"]>; labelKey: string }[] = [
  { value: "keine", labelKey: "resources.sillBoard.keine" },
  { value: "innen", labelKey: "resources.sillBoard.innen" },
  { value: "aussen", labelKey: "resources.sillBoard.aussen" },
  { value: "beide", labelKey: "resources.sillBoard.beide" },
];

export function WindowStylesTab({
  project,
  onAddWindowType,
  onPatchWindowType,
  onDeleteWindowType,
}: {
  project: Project;
  onAddWindowType?: () => void;
  onPatchWindowType?: (id: string, patch: Partial<WindowType>) => void;
  onDeleteWindowType?: (id: string) => void;
}) {
  return (
    <TypeLibraryTab
      types={project.windowTypes ?? []}
      hintKey="resources.windowTypes.hint"
      emptyKey="resources.windowTypes.empty"
      placeholderKey="resources.windowTypes.placeholder"
      deleteKeyPrefix="resources.delete.windowType"
      onAdd={onAddWindowType}
      onPatch={onPatchWindowType}
      onDelete={onDeleteWindowType}
      renderFields={(win, patch) => (
        <>
          <FieldRow label={t("resources.field.windowKind")}>
            <SelectField
              value={win.kind}
              onChange={(kind) => patch({ kind })}
              options={WINDOW_KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.wingCount")}>
            <NumberField
              value={win.wingCount}
              onChange={(wingCount) => patch({ wingCount: Math.round(wingCount) })}
              step={1}
              min={1}
              max={4}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.mullionRows")}>
            <NumberField
              value={win.mullionRows ?? 1}
              onChange={(mullionRows) => patch({ mullionRows: Math.max(1, Math.round(mullionRows)) })}
              step={1}
              min={1}
              max={4}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.mullionCols")}>
            <NumberField
              value={win.mullionCols ?? 1}
              onChange={(mullionCols) => patch({ mullionCols: Math.max(1, Math.round(mullionCols)) })}
              step={1}
              min={1}
              max={4}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.glazing")}>
            <SelectField
              value={win.glazing}
              onChange={(glazing) => patch({ glazing })}
              options={WINDOW_GLAZING_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameThickness")}>
            <NumberField
              value={win.frameThickness}
              onChange={(frameThickness) => patch({ frameThickness })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameDepth")}>
            <NumberField
              value={win.frameDepth ?? 0}
              onChange={(frameDepth) => patch({ frameDepth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.frameWidth")}>
            <NumberField
              value={win.frameWidth ?? 0.06}
              onChange={(frameWidth) => patch({ frameWidth })}
              step={0.005}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.insetFromFace")}>
            <NumberField
              value={win.insetFromFace ?? 0}
              onChange={(insetFromFace) => patch({ insetFromFace })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          {(win.insetFromFace ?? 0) > 0 && (
            <FieldRow label={t("resources.field.insetFace")}>
              <SelectField
                value={win.insetFace ?? "aussen"}
                onChange={(insetFace) => patch({ insetFace })}
                options={INSET_FACE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              />
            </FieldRow>
          )}
          <FieldRow label={t("resources.field.innerLayerRecess")}>
            <input
              type="checkbox"
              checked={!!win.innerLayerRecess}
              onChange={(e) => patch({ innerLayerRecess: e.target.checked })}
              title={t("resources.field.innerLayerRecess.hint")}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.transomHeight")}>
            <NumberField
              value={win.transomHeight ?? 0}
              onChange={(transomHeight) => patch({ transomHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultSillHeight")}>
            <NumberField
              value={win.defaultSillHeight}
              onChange={(defaultSillHeight) => patch({ defaultSillHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultWidth")}>
            <NumberField
              value={win.defaultWidth}
              onChange={(defaultWidth) => patch({ defaultWidth })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.defaultHeight")}>
            <NumberField
              value={win.defaultHeight}
              onChange={(defaultHeight) => patch({ defaultHeight })}
              step={0.01}
              min={0}
            />
          </FieldRow>
          <FieldRow label={t("resources.field.sillBoard")}>
            <SelectField
              value={win.sillBoard ?? "keine"}
              onChange={(sillBoard) => patch({ sillBoard })}
              options={WINDOW_SILL_BOARD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            />
          </FieldRow>
        </>
      )}
    />
  );
}
