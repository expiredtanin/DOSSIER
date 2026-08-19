// Tabs „Wandstile", „Deckenstile" und „Dachtypen" — geschichteter Aufbau.
// Alle drei Ressourcen teilen Struktur (WallType/CeilingType/RoofType =
// {id,name,layers[]}) und Editor: ein Master-Detail-Layout wie bei Schraffuren/
// Linien. Liste links = je Typ eine Zeile mit kleiner Querschnitt-Vorschau +
// Name; Detail rechts = Aufbau-Editor (Schichten stapeln: Bauteil/Dicke/
// Fugenlinie, hinzufügen/entfernen/umordnen) + großer Live-Querschnitt. Ein
// gemeinsames Detail-Panel {@link LayeredStyleDetail}, parametrisiert über die
// Orientierung (Wand: Bänder nebeneinander / Decke+Dach: liegend gestapelt)
// und die jeweiligen Handler.
//
// Fugen: `layer[i].jointLineStyleId` ist der Linienstil der INNEREN Kante der
// Schicht i (Fuge zur nächst-inneren Schicht). Die innerste Schicht hat keine
// innere Fuge (ihre Kante ist der Innenumriss) → dort kein Dropdown.

import { useState } from "react";
import type { CeilingType, Layer, Project, RoofType, WallType } from "../../model/types";
import { WallTypeSwatch } from "../hatchPreview";
import type { SwatchLayer } from "../hatchPreview";
import { t } from "../../i18n";
import { DeleteButton, FieldRow, NumberField, SelectField } from "./fields";

/** Wand-, Decken- und Dachtyp teilen dieselbe Form (`{id,name,layers}`). */
type LayeredStyle = WallType | CeilingType | RoofType;

/**
 * Baut die Querschnitt-Bänder (eine je Schicht) aus den Bauteil-Schnitt-
 * schraffuren: Schicht → Bauteil → dessen `hatchId` → HatchStyle. Fehlt das
 * Bauteil/die Schraffur, bleibt das Band leer (weiß).
 */
function swatchLayersOf(style: LayeredStyle, project: Project): SwatchLayer[] {
  return style.layers.map((l) => {
    const comp = project.components.find((c) => c.id === l.componentId);
    const hatch = comp
      ? project.hatches.find((hh) => hh.id === comp.hatchId)
      : undefined;
    return { hatch, thickness: l.thickness };
  });
}

/** Detail-Panel EINES Wand-/Decken-/Dachtyps (rechte Seite des Master-Detail-Layouts). */
function LayeredStyleDetail({
  style,
  project,
  orientation,
  onPatch,
  onDelete,
  deleteTitle,
  namePlaceholder,
}: {
  style: LayeredStyle;
  project: Project;
  orientation: "wall" | "ceiling";
  onPatch: (patch: Partial<LayeredStyle>) => void;
  onDelete: () => void;
  deleteTitle: string;
  namePlaceholder: string;
}) {
  // Sentinel „— (Haarlinie)": kein Feld gesetzt → Standard-Haarlinie 0.02 mm.
  const DEFAULT = "__default__";
  const jointOptions = [
    { value: DEFAULT, label: t("resources.joint.default") },
    ...project.lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];
  const compOptions =
    project.components.length > 0
      ? project.components.map((c) => ({ value: c.id, label: c.name }))
      : [{ value: "", label: "—" }];

  const layers = style.layers;
  const setLayers = (next: Layer[]) => onPatch({ layers: next });
  const patchLayer = (i: number, patch: Partial<Layer>) =>
    setLayers(layers.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const addLayer = () =>
    setLayers([
      ...layers,
      { componentId: project.components[0]?.id ?? "", thickness: 0.1 },
    ]);
  const removeLayer = (i: number) => {
    if (layers.length <= 1) return;
    setLayers(layers.filter((_, k) => k !== i));
  };
  const moveLayer = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= layers.length) return;
    const next = layers.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setLayers(next);
  };

  return (
    <div className="res-md-detail-inner">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={style.name}
          placeholder={namePlaceholder}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <DeleteButton onClick={onDelete} title={deleteTitle} />
      </div>

      <div className="res-md-preview">
        <WallTypeSwatch
          layers={swatchLayersOf(style, project)}
          width={orientation === "wall" ? 240 : 132}
          height={orientation === "wall" ? 96 : 132}
          orientation={orientation}
        />
      </div>

      <div className="res-layers">
        {layers.map((layer, i) => {
          const isInner = i === layers.length - 1;
          return (
            <div key={i} className="res-layer">
              <div className="res-layer-move">
                <button
                  type="button"
                  className="res-layer-btn"
                  title={t("resources.layer.moveUp")}
                  disabled={i === 0}
                  onClick={() => moveLayer(i, -1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="res-layer-btn"
                  title={t("resources.layer.moveDown")}
                  disabled={isInner}
                  onClick={() => moveLayer(i, 1)}
                >
                  ▼
                </button>
              </div>
              <div className="res-layer-fields">
                <FieldRow label={t("resources.col.component")}>
                  <SelectField
                    value={layer.componentId}
                    onChange={(componentId) => patchLayer(i, { componentId })}
                    options={compOptions}
                  />
                </FieldRow>
                <FieldRow label={t("resources.col.thickness")}>
                  <NumberField
                    value={Math.round(layer.thickness * 1000)}
                    onChange={(mm) =>
                      patchLayer(i, { thickness: Math.max(0, mm) / 1000 })
                    }
                    step={5}
                    min={0}
                  />
                </FieldRow>
                <FieldRow label={t("resources.col.joint")}>
                  {isInner ? (
                    <span className="res-joint-none">–</span>
                  ) : (
                    <SelectField
                      value={layer.jointLineStyleId ?? DEFAULT}
                      onChange={(v) =>
                        patchLayer(i, {
                          jointLineStyleId: v === DEFAULT ? undefined : v,
                        })
                      }
                      options={jointOptions}
                    />
                  )}
                </FieldRow>
              </div>
              <DeleteButton
                onClick={() => removeLayer(i)}
                title={t("resources.layer.remove")}
              />
            </div>
          );
        })}
        <button type="button" className="res-add" onClick={addLayer}>
          <span className="res-add-plus">+</span> {t("resources.layer.add")}
        </button>
      </div>
    </div>
  );
}

/**
 * Gemeinsamer Master-Detail-Tab-Rumpf für Wand-/Decken-/Dachstile: Liste links
 * (Querschnitt-Vorschau + Name, ＋-Neu in der Fusszeile), Detail rechts über
 * {@link LayeredStyleDetail}. Parametrisiert über die Ressource + Orientierung.
 */
function LayeredStylesTab({
  project,
  types,
  orientation,
  hintKey,
  emptyKey,
  placeholderKey,
  deleteKeyPrefix,
  onPatch,
  onAdd,
  onDelete,
}: {
  project: Project;
  types: LayeredStyle[];
  orientation: "wall" | "ceiling";
  hintKey: string;
  emptyKey: string;
  placeholderKey: string;
  deleteKeyPrefix: string;
  onPatch: (id: string, patch: Partial<LayeredStyle>) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = types.find((s) => s.id === selectedId) ?? types[0];

  return (
    <div className="res-tab">
      <div className="res-hint">{t(hintKey)}</div>
      <div className="res-md">
        <div className="res-md-list">
          {types.map((s) => (
            <button
              key={s.id}
              className={`res-md-row${selected?.id === s.id ? " active" : ""}`}
              onClick={() => setSelectedId(s.id)}
            >
              <span className="res-md-row-thumb">
                <WallTypeSwatch
                  layers={swatchLayersOf(s, project)}
                  width={46}
                  height={28}
                  orientation={orientation}
                />
              </span>
              <span className="res-md-row-name">{s.name}</span>
            </button>
          ))}
          {types.length === 0 && (
            <div className="res-md-empty">{t(emptyKey)}</div>
          )}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={() => onAdd()}>
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <LayeredStyleDetail
              key={selected.id}
              style={selected}
              project={project}
              orientation={orientation}
              onPatch={(patch) => onPatch(selected.id, patch)}
              onDelete={() => onDelete(selected.id)}
              deleteTitle={t(deleteKeyPrefix, { name: selected.name })}
              namePlaceholder={t(placeholderKey)}
            />
          ) : (
            <div className="res-md-empty">{t(emptyKey)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function WallStylesTab({
  project,
  onPatchWallType,
  onAddWallType,
  onDeleteWallType,
}: {
  project: Project;
  onPatchWallType: (id: string, patch: Partial<WallType>) => void;
  onAddWallType: () => void;
  onDeleteWallType: (id: string) => void;
}) {
  return (
    <LayeredStylesTab
      project={project}
      types={project.wallTypes}
      orientation="wall"
      hintKey="resources.wallStyles.hint"
      emptyKey="resources.wallStyles.empty"
      placeholderKey="resources.wallStyles.placeholder"
      deleteKeyPrefix="resources.delete.wallType"
      onPatch={onPatchWallType}
      onAdd={onAddWallType}
      onDelete={onDeleteWallType}
    />
  );
}

/**
 * Tab „Deckenstile" — das liegende Gegenstück zu {@link WallStylesTab}: nutzt
 * denselben {@link LayeredStylesTab}-Rumpf, nur die Ressource (`ceilingTypes`),
 * die Orientierung (gestapelt) und die Handler unterscheiden sich.
 */
export function CeilingStylesTab({
  project,
  onPatchCeilingType,
  onAddCeilingType,
  onDeleteCeilingType,
}: {
  project: Project;
  onPatchCeilingType: (id: string, patch: Partial<CeilingType>) => void;
  onAddCeilingType: () => void;
  onDeleteCeilingType: (id: string) => void;
}) {
  return (
    <LayeredStylesTab
      project={project}
      types={project.ceilingTypes ?? []}
      orientation="ceiling"
      hintKey="resources.ceilingStyles.hint"
      emptyKey="resources.ceilingStyles.empty"
      placeholderKey="resources.ceilingStyles.placeholder"
      deleteKeyPrefix="resources.delete.ceilingType"
      onPatch={onPatchCeilingType}
      onAdd={onAddCeilingType}
      onDelete={onDeleteCeilingType}
    />
  );
}

/**
 * Tab „Dachtypen" — das geneigte Gegenstück zu {@link CeilingStylesTab}: gleicher
 * {@link LayeredStylesTab}-Rumpf (Schichtaufbau aussen/Eindeckung → innen/
 * Verkleidung), Ressource `roofTypes`. Vorschau in Decken-Orientierung
 * (gestapelt) — für die Schichtreihenfolge/-dicken ausreichend.
 */
export function RoofStylesTab({
  project,
  onPatchRoofType,
  onAddRoofType,
  onDeleteRoofType,
}: {
  project: Project;
  onPatchRoofType: (id: string, patch: Partial<RoofType>) => void;
  onAddRoofType: () => void;
  onDeleteRoofType: (id: string) => void;
}) {
  return (
    <LayeredStylesTab
      project={project}
      types={project.roofTypes ?? []}
      orientation="ceiling"
      hintKey="resources.roofStyles.hint"
      emptyKey="resources.roofStyles.empty"
      placeholderKey="resources.roofStyles.placeholder"
      deleteKeyPrefix="resources.delete.roofType"
      onPatch={onPatchRoofType}
      onAdd={onAddRoofType}
      onDelete={onDeleteRoofType}
    />
  );
}
