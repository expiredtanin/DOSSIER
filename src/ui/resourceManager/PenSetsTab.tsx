// Tab „Stifte" (ArchiCAD-Stiftsatz-Muster) — Master-Detail wie die übrigen
// Ressourcen-Tabs: links die Stiftsätze (einer davon AKTIV), rechts für den
// gewählten Satz die Farbe JEDES projektweiten Stifts. Ein Bauteil/eine Ebene
// koppelt sich an einen Stift (`xxxPenId`, s. ComponentsTab/App.tsx-Ebenen-
// Editor) statt an eine freie Farbe — wechselt der AKTIVE Stiftsatz hier,
// ändern sich alle gekoppelten Farben sofort (`rebakePenColors`).

import { useState } from "react";
import type { ColorPen, PenSet, Project } from "../../model/types";
import { PEN_WEIGHTS } from "../../model/types";
import { PEN_FALLBACK_COLOR, PEN_FALLBACK_WEIGHT } from "../../model/penSets";
import { t } from "../../i18n";
import { PenSwatchPicker } from "../PenSwatchPicker";
import { DeleteButton, FieldRow, NumberField, TextField } from "./fields";

/**
 * Detail-Panel EINES Stiftsatzes: Umbenennen/Löschen + Tabelle Farbe+
 * Strichstärke über alle Stifte (ein Stift trägt beides zusammen, s.
 * `model/penSets.ts`::PenStyle).
 */
function PenSetDetail({
  penSet,
  pens,
  isActive,
  onRename,
  onDelete,
  onActivate,
  onPatchColor,
  onPatchWeight,
  project,
  onSaveColor,
  onAddPen,
  onRenamePen,
  onDeletePen,
}: {
  penSet: PenSet;
  pens: ColorPen[];
  isActive: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
  onActivate: () => void;
  onPatchColor: (penId: string, color: string) => void;
  project: Project;
  onSaveColor?: (paletteId: string, hex: string) => void;
  onPatchWeight: (penId: string, weight: number) => void;
  onAddPen?: () => void;
  onRenamePen?: (id: string, name: string) => void;
  onDeletePen?: (id: string) => void;
}) {
  return (
    <div className="res-md-detail-inner">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={penSet.name}
          placeholder={t("resources.pens.setPlaceholder")}
          onChange={(e) => onRename(e.target.value)}
        />
        <DeleteButton onClick={onDelete} title={t("resources.delete.penSet", { name: penSet.name })} />
      </div>

      {isActive ? (
        <div className="res-hint">{t("resources.pens.isActive")}</div>
      ) : (
        <button className="res-add" onClick={onActivate}>
          {t("resources.pens.activate")}
        </button>
      )}

      <div className="res-fields">
        {pens.map((pen) => {
          const style = penSet.pens[pen.id] ?? { color: PEN_FALLBACK_COLOR, weight: PEN_FALLBACK_WEIGHT };
          return (
            <FieldRow key={pen.id} label={pen.id}>
              <div className="res-pen-row">
                <TextField value={pen.name} onChange={(name) => onRenamePen?.(pen.id, name)} />
                <PenSwatchPicker
                  color={style.color}
                  onChange={(color) => onPatchColor(pen.id, color)}
                  customPalettes={project.customPalettes}
                  builtinBanks={project.builtinPaletteBanks}
                  onSaveColor={onSaveColor}
                />
                <NumberField
                  value={style.weight}
                  onChange={(weight) => onPatchWeight(pen.id, weight)}
                  step={0.01}
                  min={0}
                  list="pen-set-weights"
                />
                <DeleteButton
                  onClick={() => onDeletePen?.(pen.id)}
                  title={t("resources.delete.pen", { name: pen.name })}
                />
              </div>
            </FieldRow>
          );
        })}
        {pens.length === 0 && <div className="res-empty">{t("resources.pens.empty")}</div>}
      </div>
      <div className="res-md-listfoot">
        <button className="res-add" onClick={onAddPen}>
          <span className="res-add-plus">+</span> {t("resources.pens.addPen")}
        </button>
      </div>
    </div>
  );
}

export function PenSetsTab({
  project,
  onAddPen,
  onRenamePen,
  onDeletePen,
  onAddPenSet,
  onRenamePenSet,
  onDeletePenSet,
  onSetActivePenSet,
  onPatchPenSetColor,
  onPatchPenSetWeight,
  onSeedStandardPenSet,
  onAddColorToCustomPalette,
}: {
  project: Project;
  onAddPen?: () => void;
  onRenamePen?: (id: string, name: string) => void;
  onDeletePen?: (id: string) => void;
  onAddPenSet?: () => void;
  onRenamePenSet?: (id: string, name: string) => void;
  onDeletePenSet?: (id: string) => void;
  onSetActivePenSet?: (id: string) => void;
  onPatchPenSetColor?: (setId: string, penId: string, color: string) => void;
  onPatchPenSetWeight?: (setId: string, penId: string, weight: number) => void;
  onSeedStandardPenSet?: () => void;
  onAddColorToCustomPalette?: (paletteId: string | undefined, hex: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pens = project.pens ?? [];
  const penSets = project.penSets ?? [];
  const selected = penSets.find((s) => s.id === selectedId) ?? penSets[0];

  return (
    <div className="res-tab">
      {/* Vorschlagswerte für die Strichstärke (Standard-Stiftbreiten in mm) — analog LinesTab. */}
      <datalist id="pen-set-weights">
        {PEN_WEIGHTS.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
      <div className="res-hint">{t("resources.pens.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {penSets.map((s) => (
            <button
              key={s.id}
              className={`res-md-row${selected?.id === s.id ? " active" : ""}`}
              onClick={() => setSelectedId(s.id)}
            >
              <span className="res-md-row-name">{s.name}</span>
              {project.activePenSetId === s.id && (
                <span className="res-pen-active-badge">{t("resources.pens.activeBadge")}</span>
              )}
            </button>
          ))}
          {penSets.length === 0 && (
            <div className="res-md-empty">{t("resources.pens.emptySets")}</div>
          )}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={() => onAddPenSet?.()}>
              <span className="res-add-plus">+</span> {t("resources.pens.addSet")}
            </button>
            <button
              className="res-add"
              title={t("resources.pens.seedStandard.hint")}
              onClick={() => onSeedStandardPenSet?.()}
            >
              {t("resources.pens.seedStandard")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <PenSetDetail
              key={selected.id}
              penSet={selected}
              pens={pens}
              project={project}
              onSaveColor={onAddColorToCustomPalette}
              isActive={project.activePenSetId === selected.id}
              onRename={(name) => onRenamePenSet?.(selected.id, name)}
              onDelete={() => onDeletePenSet?.(selected.id)}
              onActivate={() => onSetActivePenSet?.(selected.id)}
              onPatchColor={(penId, color) => onPatchPenSetColor?.(selected.id, penId, color)}
              onPatchWeight={(penId, weight) => onPatchPenSetWeight?.(selected.id, penId, weight)}
              onAddPen={onAddPen}
              onRenamePen={onRenamePen}
              onDeletePen={onDeletePen}
            />
          ) : (
            <div className="res-md-empty">{t("resources.pens.emptySets")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
