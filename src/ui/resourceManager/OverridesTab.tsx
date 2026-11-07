// Tab „Overrides" (grafische Overrides, Regel-Engine A1) — Master-Detail wie
// Linien/Wandstile: Liste links = Regeln in PRIORITÄTS-Reihenfolge (oben
// gewinnt pro Aktions-Feld) mit Aktiv-Checkbox, Auf/Ab und Löschen; Detail
// rechts = Bedingungen (Kriterium/Operator/Wert, weitere Bedingungen mit UND)
// + Massstab-Kriterium ([33], ab/bis 1:n) + optionale Aktionen (Farbe/Strichstärke/
// Linienstil; [33] Füllung, Schraffur, Umriss geschnittener Flächen/Schichten und Ansichtsflächen, Ausblenden in
// der Ansicht). Reines Rendering-Overlay — die
// Auswertung liegt im Kern (`src-tauri/core/src/plan/overrides.rs`);
// Elementdaten bleiben unverändert.

import { useState } from "react";
import type { OverrideCondition, OverrideConditionType, OverrideOperator, OverrideRule, Project } from "../../model/types";
import { PEN_WEIGHTS } from "../../model/types";
import { t } from "../../i18n";
import { ColorField, DeleteButton, FieldRow, NumberField, SelectField, TextField } from "./fields";

/** Bedingungs-Typen (UI-Beschriftung übersetzt, Werte englisch). */
const OVERRIDE_TYPE_OPTIONS: { value: OverrideConditionType; labelKey: string }[] = [
  { value: "layer_name", labelKey: "resources.overrides.condType.layer" },
  { value: "object_name", labelKey: "resources.overrides.condType.object" },
  { value: "element_kind", labelKey: "resources.overrides.condType.elementKind" },
  { value: "layer_function", labelKey: "resources.overrides.condType.layerFunction" },
  { value: "layer_position", labelKey: "resources.overrides.condType.layerPosition" },
  { value: "material", labelKey: "resources.overrides.condType.material" },
  { value: "material_category", labelKey: "resources.overrides.condType.materialCategory" },
  { value: "view_kind", labelKey: "resources.overrides.condType.viewKind" },
];

/** [33] Feste Werte je Kriterium (Auswahl statt Freitext); Beschriftung `resources.overrides.val.<typ>.<wert>`. */
const ENUM_VALUES: Partial<Record<OverrideConditionType, readonly string[]>> = {
  element_kind: ["wall", "slab", "ground_slab", "roof", "stair", "column", "opening", "room", "shadow", "terrain", "mesh"],
  layer_function: ["structure", "insulation", "screed", "finish", "plaster", "substructure", "membrane", "cladding", "air"],
  layer_position: ["above", "structure", "below"],
  view_kind: ["plan", "section", "elevation"],
  material_category: ["concrete", "masonry", "timber", "insulation", "screed", "flooring", "plaster", "loose_fill", "metal", "glass", "membrane", "air", "cladding", "stone", "other"],
};

/** Vergleichs-Operatoren (UI-Beschriftung übersetzt, Werte englisch). */
const OVERRIDE_OP_OPTIONS: { value: OverrideOperator; labelKey: string }[] = [
  { value: "equals", labelKey: "resources.overrides.op.equals" },
  { value: "contains", labelKey: "resources.overrides.op.contains" },
  { value: "starts_with", labelKey: "resources.overrides.op.startsWith" },
  { value: "not_equals", labelKey: "resources.overrides.op.notEquals" },
];

const valueLabel = (type: OverrideConditionType, value: string): string =>
  ENUM_VALUES[type]?.includes(value) ? t(`resources.overrides.val.${type}.${value}`) : `„${value}"`;

/** [33] Vorschläge für das Massstab-Kriterium (Nenner 1:n). */
const SCALE_SUGGESTIONS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000];

/** [33] Massstab-Kriterium als Text („ab 1:100“, „1:50 bis 1:200“); leer ohne Kriterium. */
export function overrideScaleSummary(rule: Pick<OverrideRule, "minScale" | "maxScale">): string {
  const lo = rule.minScale;
  const hi = rule.maxScale;
  if (lo && hi) return t("resources.overrides.scale.range", { from: lo, to: hi });
  if (lo) return t("resources.overrides.scale.from", { n: lo });
  if (hi) return t("resources.overrides.scale.to", { n: hi });
  return "";
}

/** Kompakte Bedingungs-Zusammenfassung für die Listenzeile (weitere Bedingungen mit „und"). */
function overrideConditionSummary(rule: OverrideRule): string {
  const scale = overrideScaleSummary(rule);
  return [rule.condition, ...(rule.conditions ?? [])]
    .map((c) => {
      const type = OVERRIDE_TYPE_OPTIONS.find((o) => o.value === c.type);
      const op = OVERRIDE_OP_OPTIONS.find((o) => o.value === c.operator);
      return `${type ? t(type.labelKey) : c.type} ${op ? t(op.labelKey) : c.operator} ${valueLabel(c.type, c.value)}`;
    })
    .concat(scale ? [scale] : [])
    .join(` ${t("resources.overrides.and")} `);
}

/** Optionale Aktion: Checkbox (an/aus) + Steuerelement, solange sie an ist. */
function OptionalAction({
  label,
  active,
  onToggle,
  children,
}: {
  label: string;
  active: boolean;
  onToggle: (on: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="res-field">
      <span className="res-field-label">
        <label className="res-ov-action-toggle">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => onToggle(e.target.checked)}
          />{" "}
          {label}
        </label>
      </span>
      <span className="res-field-control">
        {active ? children : <span className="res-joint-none">–</span>}
      </span>
    </div>
  );
}

/** Eine Bedingung: Kriterium, Operator, Wert (feste Werte als Auswahl, Baustoff mit Vorschlägen). */
function ConditionFields({
  cond,
  project,
  onChange,
}: {
  cond: OverrideCondition;
  project: Project;
  onChange: (c: OverrideCondition) => void;
}) {
  const values = ENUM_VALUES[cond.type];
  const setType = (type: OverrideConditionType) => {
    const vals = ENUM_VALUES[type];
    onChange({ ...cond, type, value: vals && !vals.includes(cond.value) ? vals[0] : cond.value });
  };
  return (
    <>
      <FieldRow label={t("resources.overrides.condType")}>
        <SelectField
          value={cond.type}
          onChange={setType}
          options={OVERRIDE_TYPE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        />
      </FieldRow>
      <FieldRow label={t("resources.overrides.operator")}>
        <SelectField
          value={cond.operator}
          onChange={(operator) => onChange({ ...cond, operator })}
          options={OVERRIDE_OP_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        />
      </FieldRow>
      <FieldRow label={t("resources.overrides.value")}>
        {values ? (
          <SelectField
            value={values.includes(cond.value) ? cond.value : values[0]}
            onChange={(value) => onChange({ ...cond, value })}
            options={values.map((v) => ({ value: v, label: t(`resources.overrides.val.${cond.type}.${v}`) }))}
          />
        ) : cond.type === "material" ? (
          <>
            <input
              className="res-input"
              list="ov-materials"
              value={cond.value}
              placeholder={t("resources.overrides.value.material")}
              onChange={(e) => onChange({ ...cond, value: e.target.value })}
            />
            <datalist id="ov-materials">
              {project.components.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </>
        ) : (
          <TextField
            value={cond.value}
            placeholder={t("resources.overrides.value.placeholder")}
            onChange={(value) => onChange({ ...cond, value })}
          />
        )}
      </FieldRow>
    </>
  );
}

/** Detail-Panel EINER Override-Regel (rechte Seite des Master-Detail-Layouts). */
function OverrideRuleDetail({
  rule,
  project,
  onPatch,
  onDelete,
}: {
  rule: OverrideRule;
  project: Project;
  onPatch: (patch: Partial<OverrideRule>) => void;
  onDelete: () => void;
}) {
  const patchActions = (patch: Partial<OverrideRule["actions"]>) =>
    onPatch({ actions: { ...rule.actions, ...patch } });
  const more = rule.conditions ?? [];
  const setMore = (next: OverrideCondition[]) => onPatch({ conditions: next.length ? next : undefined });
  // Sentinel „—": kein Linienstil-Override.
  const NONE = "__none__";
  const lineOptions = [
    { value: NONE, label: t("resources.overrides.linetype.none") },
    ...project.lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];
  const hatchOptions = [
    { value: "none", label: t("resources.overrides.hatch.none") },
    { value: "material", label: t("resources.overrides.hatch.material") },
    ...project.hatches.map((h) => ({ value: h.id, label: h.name })),
  ];

  return (
    <div className="res-md-detail-inner" data-testid="override-rule-detail">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={rule.name}
          placeholder={t("resources.overrides.placeholder")}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <DeleteButton onClick={onDelete} title={t("resources.overrides.delete")} />
      </div>

      <div className="res-hint">{t("resources.overrides.condition")}</div>
      <ConditionFields cond={rule.condition} project={project} onChange={(condition) => onPatch({ condition })} />
      {more.map((c, i) => (
        <div key={i} className="res-ov-more" data-testid="override-more-condition">
          <div className="res-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ flex: 1 }}>{t("resources.overrides.andCondition")}</span>
            <DeleteButton onClick={() => setMore(more.filter((_, j) => j !== i))} title={t("resources.overrides.removeCondition")} />
          </div>
          <ConditionFields cond={c} project={project} onChange={(nc) => setMore(more.map((x, j) => (j === i ? nc : x)))} />
        </div>
      ))}
      <button
        className="res-add"
        data-testid="override-add-condition"
        onClick={() => setMore([...more, { type: "element_kind", operator: "equals", value: "slab" }])}
      >
        <span className="res-add-plus">+</span> {t("resources.overrides.addCondition")}
      </button>
      <div className="res-hint">{t("resources.overrides.layerHint")}</div>

      {/* [33] Massstab-Kriterium: Regel nur im Bereich 1:von … 1:bis (Nenner, Grenzen inklusive). */}
      <div className="res-hint">{t("resources.overrides.scale")}</div>
      <datalist id="ov-scales">
        {SCALE_SUGGESTIONS.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div data-testid="override-scale">
        <OptionalAction
          label={t("resources.overrides.scale.min")}
          active={rule.minScale !== undefined}
          onToggle={(on) => onPatch({ minScale: on ? 100 : undefined })}
        >
          <span className="res-ov-scale" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            1:{" "}
            <NumberField value={rule.minScale ?? 100} onChange={(n) => n > 0 && onPatch({ minScale: n })} step={10} min={1} list="ov-scales" />
          </span>
        </OptionalAction>
        <OptionalAction
          label={t("resources.overrides.scale.max")}
          active={rule.maxScale !== undefined}
          onToggle={(on) => onPatch({ maxScale: on ? 100 : undefined })}
        >
          <span className="res-ov-scale" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            1:{" "}
            <NumberField value={rule.maxScale ?? 100} onChange={(n) => n > 0 && onPatch({ maxScale: n })} step={10} min={1} list="ov-scales" />
          </span>
        </OptionalAction>
      </div>

      <div className="res-hint">{t("resources.overrides.actions")}</div>
      {/* Vorschlagswerte für die Strichstärke (Standard-Stiftbreiten in mm). */}
      <datalist id="ov-pen-weights">
        {PEN_WEIGHTS.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
      <OptionalAction
        label={t("resources.overrides.action.color")}
        active={rule.actions.color !== undefined}
        onToggle={(on) => patchActions({ color: on ? "#808080" : undefined })}
      >
        <ColorField
          color={rule.actions.color ?? "#808080"}
          onChange={(color) => patchActions({ color })}
        />
      </OptionalAction>
      <OptionalAction
        label={t("resources.overrides.action.lineweight")}
        active={rule.actions.lineweight !== undefined}
        onToggle={(on) => patchActions({ lineweight: on ? 0.35 : undefined })}
      >
        <NumberField
          value={rule.actions.lineweight ?? 0.35}
          onChange={(lineweight) => patchActions({ lineweight: Math.max(0, lineweight) })}
          step={0.05}
          min={0}
          list="ov-pen-weights"
        />
      </OptionalAction>
      <OptionalAction
        label={t("resources.overrides.action.linetype")}
        active={rule.actions.linetypeId !== undefined}
        onToggle={(on) =>
          patchActions({
            linetypeId: on ? project.lineStyles[0]?.id : undefined,
          })
        }
      >
        <SelectField
          value={rule.actions.linetypeId ?? NONE}
          onChange={(v) =>
            patchActions({ linetypeId: v === NONE ? undefined : v })
          }
          options={lineOptions}
        />
      </OptionalAction>
      <div className="res-hint">{t("resources.overrides.cutActions")}</div>
      <OptionalAction
        label={t("resources.overrides.action.fill")}
        active={rule.actions.fillColor !== undefined}
        onToggle={(on) => patchActions({ fillColor: on ? "#ffffff" : undefined })}
      >
        <ColorField color={rule.actions.fillColor ?? "#ffffff"} onChange={(fillColor) => patchActions({ fillColor })} />
      </OptionalAction>
      <OptionalAction
        label={t("resources.overrides.action.hatch")}
        active={rule.actions.hatch !== undefined}
        onToggle={(on) => patchActions({ hatch: on ? "none" : undefined })}
      >
        <SelectField value={rule.actions.hatch ?? "none"} onChange={(hatch) => patchActions({ hatch })} options={hatchOptions} />
      </OptionalAction>
      <OptionalAction
        label={t("resources.overrides.action.outline")}
        active={rule.actions.outline !== undefined}
        onToggle={(on) => patchActions({ outline: on ? true : undefined })}
      >
        <input
          type="checkbox"
          aria-label={t("resources.overrides.action.outline")}
          checked={rule.actions.outline === true}
          onChange={(e) => patchActions({ outline: e.target.checked })}
        />
      </OptionalAction>
      <OptionalAction
        label={t("resources.overrides.action.hide")}
        active={rule.actions.hide !== undefined}
        onToggle={(on) => patchActions({ hide: on ? true : undefined })}
      >
        <input
          type="checkbox"
          aria-label={t("resources.overrides.action.hide")}
          checked={rule.actions.hide === true}
          onChange={(e) => patchActions({ hide: e.target.checked })}
        />
      </OptionalAction>
    </div>
  );
}

/** Tab „Overrides": Regelliste (Priorität von oben nach unten) + Detail. */
export function OverridesTab({
  project,
  onSetOverrideRules,
}: {
  project: Project;
  onSetOverrideRules?: (rules: OverrideRule[]) => void;
}) {
  const rules = project.overrideRules ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rules.find((r) => r.id === selectedId) ?? rules[0];

  const setRules = (next: OverrideRule[]) => onSetOverrideRules?.(next);
  const patchRule = (id: string, patch: Partial<OverrideRule>) =>
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRule = () => {
    const rule: OverrideRule = {
      id: `ov-${Date.now()}`,
      name: t("resources.overrides.defaultName"),
      enabled: true,
      condition: { type: "layer_name", operator: "contains", value: "" },
      actions: {},
    };
    setRules([...rules, rule]);
    setSelectedId(rule.id);
  };
  const deleteRule = (id: string) => setRules(rules.filter((r) => r.id !== id));
  const moveRule = (id: string, dir: -1 | 1) => {
    const i = rules.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= rules.length) return;
    const next = rules.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setRules(next);
  };

  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.overrides.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {rules.map((r) => (
            <div
              key={r.id}
              role="button"
              tabIndex={0}
              className={`res-md-row res-ov-row${
                selected?.id === r.id ? " active" : ""
              }`}
              style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
              onClick={() => setSelectedId(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setSelectedId(r.id);
              }}
            >
              <input
                type="checkbox"
                checked={r.enabled}
                title={t("resources.overrides.enabled")}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => patchRule(r.id, { enabled: e.target.checked })}
              />
              <span
                className="res-md-row-name"
                style={{ flex: 1, opacity: r.enabled ? 1 : 0.5 }}
              >
                {r.name || t("resources.overrides.placeholder")}
                <span
                  style={{ display: "block", fontSize: "0.85em", opacity: 0.65 }}
                >
                  {overrideConditionSummary(r)}
                </span>
              </span>
              <button
                type="button"
                className="res-layer-btn"
                title={t("resources.overrides.moveUp")}
                disabled={rules[0]?.id === r.id}
                onClick={(e) => {
                  e.stopPropagation();
                  moveRule(r.id, -1);
                }}
              >
                ▲
              </button>
              <button
                type="button"
                className="res-layer-btn"
                title={t("resources.overrides.moveDown")}
                disabled={rules[rules.length - 1]?.id === r.id}
                onClick={(e) => {
                  e.stopPropagation();
                  moveRule(r.id, 1);
                }}
              >
                ▼
              </button>
            </div>
          ))}
          {rules.length === 0 && (
            <div className="res-md-empty">{t("resources.overrides.empty")}</div>
          )}
          <div className="res-md-listfoot">
            <button
              className="res-add"
              onClick={addRule}
              disabled={!onSetOverrideRules}
            >
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <OverrideRuleDetail
              key={selected.id}
              rule={selected}
              project={project}
              onPatch={(patch) => patchRule(selected.id, patch)}
              onDelete={() => deleteRule(selected.id)}
            />
          ) : (
            <div className="res-md-empty">{t("resources.overrides.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
