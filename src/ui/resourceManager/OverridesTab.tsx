// Tab „Overrides" (grafische Overrides, Regel-Engine A1) — Master-Detail wie
// Linien/Wandstile: Liste links = Regeln in PRIORITÄTS-Reihenfolge (oben
// gewinnt pro Aktions-Feld) mit Aktiv-Checkbox, Auf/Ab und Löschen; Detail
// rechts = Bedingung (Kriterium/Operator/Wert) + optionale Aktionen (Farbe/
// Strichstärke/Linienstil). Reines Rendering-Overlay — die Auswertung liegt in
// src/overrides/engine.ts, der Einhängepunkt in plan/generatePlan.ts;
// Elementdaten bleiben unverändert.

import { useState } from "react";
import type { OverrideConditionType, OverrideOperator, OverrideRule, Project } from "../../model/types";
import { PEN_WEIGHTS } from "../../model/types";
import { t } from "../../i18n";
import { ColorField, DeleteButton, FieldRow, NumberField, SelectField, TextField } from "./fields";

/** Bedingungs-Typen (UI-Beschriftung übersetzt, Werte englisch). */
const OVERRIDE_TYPE_OPTIONS: { value: OverrideConditionType; labelKey: string }[] = [
  { value: "layer_name", labelKey: "resources.overrides.condType.layer" },
  { value: "object_name", labelKey: "resources.overrides.condType.object" },
];

/** Vergleichs-Operatoren (UI-Beschriftung übersetzt, Werte englisch). */
const OVERRIDE_OP_OPTIONS: { value: OverrideOperator; labelKey: string }[] = [
  { value: "equals", labelKey: "resources.overrides.op.equals" },
  { value: "contains", labelKey: "resources.overrides.op.contains" },
  { value: "starts_with", labelKey: "resources.overrides.op.startsWith" },
  { value: "not_equals", labelKey: "resources.overrides.op.notEquals" },
];

/** Kompakte Bedingungs-Zusammenfassung für die Listenzeile. */
function overrideConditionSummary(rule: OverrideRule): string {
  const type = OVERRIDE_TYPE_OPTIONS.find((o) => o.value === rule.condition.type);
  const op = OVERRIDE_OP_OPTIONS.find((o) => o.value === rule.condition.operator);
  return `${type ? t(type.labelKey) : rule.condition.type} ${
    op ? t(op.labelKey) : rule.condition.operator
  } „${rule.condition.value}"`;
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
  const patchCondition = (patch: Partial<OverrideRule["condition"]>) =>
    onPatch({ condition: { ...rule.condition, ...patch } });
  const patchActions = (patch: Partial<OverrideRule["actions"]>) =>
    onPatch({ actions: { ...rule.actions, ...patch } });
  // Sentinel „—": kein Linienstil-Override.
  const NONE = "__none__";
  const lineOptions = [
    { value: NONE, label: t("resources.overrides.linetype.none") },
    ...project.lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];

  return (
    <div className="res-md-detail-inner">
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
      <FieldRow label={t("resources.overrides.condType")}>
        <SelectField
          value={rule.condition.type}
          onChange={(type) => patchCondition({ type })}
          options={OVERRIDE_TYPE_OPTIONS.map((o) => ({
            value: o.value,
            label: t(o.labelKey),
          }))}
        />
      </FieldRow>
      <FieldRow label={t("resources.overrides.operator")}>
        <SelectField
          value={rule.condition.operator}
          onChange={(operator) => patchCondition({ operator })}
          options={OVERRIDE_OP_OPTIONS.map((o) => ({
            value: o.value,
            label: t(o.labelKey),
          }))}
        />
      </FieldRow>
      <FieldRow label={t("resources.overrides.value")}>
        <TextField
          value={rule.condition.value}
          placeholder={t("resources.overrides.value.placeholder")}
          onChange={(value) => patchCondition({ value })}
        />
      </FieldRow>

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
