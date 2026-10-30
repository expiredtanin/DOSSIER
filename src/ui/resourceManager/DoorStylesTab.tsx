// Tab „Türtypen" — Bauart, Blattausführung/-zahl, Zarge und Standardmaße.
// Nutzt den generischen {@link TypeLibraryTab}-Rumpf (siehe dort).

import type { DoorType, Opening, Project } from "../../model/types";
import { t } from "../../i18n";
import { FieldRow, NumberField, Segmented, SelectField } from "./fields";
import { INSET_FACE_OPTIONS, TypeLibraryTab } from "./TypeLibraryTab";
import { ElevationPreview } from "../ElevationPreview";
import { openingTypePresets } from "../../model/openingPresets";
import { DoorFramePanel, FrameDetailPanel, RebatePanel } from "../OpeningDetailPanels";

/**
 * Synthetische Öffnungs-Instanz NUR für die Vorschau — s. WindowStylesTab.
 * Türen sitzen am Boden (`sillHeight` = 0, wie bei einer echten Tür-Instanz).
 */
function previewOpeningFor(door: DoorType): Opening {
  return {
    id: "preview",
    type: "opening",
    hostWallId: "",
    categoryCode: "",
    kind: "door",
    position: 0,
    width: door.defaultWidth,
    height: door.defaultHeight,
    sillHeight: 0,
    typeId: door.id,
  };
}

const DOOR_KIND_OPTIONS: { value: DoorType["kind"]; labelKey: string }[] = [
  { value: "dreh", labelKey: "resources.doorKind.dreh" },
  { value: "schiebe", labelKey: "resources.doorKind.schiebe" },
  { value: "wandoeffnung", labelKey: "resources.doorKind.wandoeffnung" },
  { value: "hebeschiebe", labelKey: "resources.doorKind.hebeschiebe" },
  { value: "pendel", labelKey: "resources.doorKind.pendel" },
];

const DOOR_LEAF_STYLE_OPTIONS: { value: DoorType["leafStyle"]; labelKey: string }[] = [
  { value: "glatt", labelKey: "resources.leafStyle.glatt" },
  { value: "kassette", labelKey: "resources.leafStyle.kassette" },
  { value: "glas", labelKey: "resources.leafStyle.glas" },
];

export function DoorStylesTab({
  project,
  onAddDoorType,
  onPatchDoorType,
  onDeleteDoorType,
}: {
  project: Project;
  onAddDoorType?: (preset?: DoorType) => void;
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
      onAdd={() => onAddDoorType?.()}
      presets={openingTypePresets().doorTypes.map((p) => ({ id: p.id, label: t(`preset.${p.id}`) }))}
      onAddPreset={(id) => {
        const p = openingTypePresets().doorTypes.find((x) => x.id === id);
        if (p) onAddDoorType?.({ ...p, name: t(`preset.${p.id}`) });
      }}
      onPatch={onPatchDoorType}
      onDelete={onDeleteDoorType}
      renderFields={(door, patch) => (
        <>
          <div className="res-md-preview">
            <ElevationPreview opening={previewOpeningFor(door)} dt={door} />
          </div>
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
          {door.leafStyle === "kassette" && (
            <>
              <FieldRow label={t("resources.field.panelCols")}>
                <NumberField
                  value={door.panelCols ?? 2}
                  onChange={(panelCols) => patch({ panelCols: Math.round(panelCols) })}
                  step={1}
                  min={1}
                  max={6}
                />
              </FieldRow>
              <FieldRow label={t("resources.field.panelRows")}>
                <NumberField
                  value={door.panelRows ?? 3}
                  onChange={(panelRows) => patch({ panelRows: Math.round(panelRows) })}
                  step={1}
                  min={1}
                  max={8}
                />
              </FieldRow>
            </>
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
          {/* [105] Zarge/Rahmenart, Rahmen-Detail und Anschlag — dieselben Felder wie im Dialog „Tür bearbeiten“. */}
          <details className="rm-detail-group" open={!!(door.frameKind && door.frameKind !== "zarge")}>
            <summary>{t("oed.cat.zarge")}</summary>
            <DoorFramePanel kind={door.frameKind} onKind={(frameKind) => patch({ frameKind })} value={door.doorFrame} onChange={(doorFrame) => patch({ doorFrame })} />
          </details>
          <details className="rm-detail-group" open={!!door.frameDetail}>
            <summary>{t("oed.cat.rahmendetail")} · {t("oed.cat.anschlag")}</summary>
            <FrameDetailPanel value={door.frameDetail} onChange={(frameDetail) => patch({ frameDetail })} isDoor />
            <RebatePanel value={door.frameDetail} onChange={(frameDetail) => patch({ frameDetail })} isDoor />
          </details>
        </>
      )}
    />
  );
}
