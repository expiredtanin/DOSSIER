// [272] Dock-Panel „Varianten“ (wie Archicads Design-Options-Manager): je Variante Auge und Stift — Auge = in der
// Kombination der aktiven Ansicht sichtbar (je Satz eine; ein Feld der Ebene wie der Umbaufilter, darum je Reiter eigen
// und mit Undo), Stift = Bearbeitungsvariante (neue Elemente landen in ihr; Zustand der Sitzung, kein Undo-Schritt;
// Stift impliziert Auge). Im Bearbeitungsmodus zwei Häkchen wie in Archicad: ausserhalb grau einfärben (nur Bildschirm)
// und sperren (nicht wählbar). Dazu benannte Kombinationen, Auswahl einer Variante zuweisen oder in eine Variante kopieren
// (ein Undo-Schritt), Sätze und Varianten verwalten samt „Übernehmen“ und der Vergleich der Kennzahlen/Kosten.

import { useMemo, useState } from "react";
import { t } from "../i18n";
import { useStore } from "../state/appStore";
import {
  addCombinationOps, assignCombinationOps, combinationChoice, deleteCombinationOps, designOptionCombinations, levelCombinationState, nextCombinationName, renameCombinationOps, setCombinationChoiceOps,
  acceptDesignOptionOps, addDesignOptionOps, addDesignOptionSetOps, assignDesignOptionOps, copyToDesignOptionOps, deleteDesignOptionOps, designOptionIds,
  designOptionSets, designOptionTargets, levelCombination, parseTarget, renameDesignOptionOps, renameDesignOptionSetOps, setPrimaryOptionOps,
  eyeClick, penClick, visibleOption,
} from "../core";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { InlineName } from "../ui/InlineName";
import { PromptDialog } from "../ui/PromptDialog";
import { DesignOptionsTab, type DesignOptionHandlers, type DesignOptionViewControls } from "../ui/resourceManager/DesignOptionsTab";
import { DesignOptionCompareSection } from "./DesignOptionCompareSection";
import { selectionDesignOptionIds } from "./objectInfo/DesignOptionField";

export function DesignOptionsPanel() {
  const project = useStore((s) => s.project);
  const activeLevelId = useStore((s) => s.activeLevelId);
  const selection = useStore((s) => s.selection);
  const draw = useStore((s) => s.drawDesignOption);
  const setDraw = useStore((s) => s.setDrawDesignOption);
  const grey = useStore((s) => s.designOptionGrey);
  const setGrey = useStore((s) => s.setDesignOptionGrey);
  const lock = useStore((s) => s.designOptionLock);
  const setLock = useStore((s) => s.setDesignOptionLock);
  const applyChange = useStore((s) => s.applyChange);
  const [target, setTarget] = useState("");
  const [showCompare, setShowCompare] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const sets = designOptionSets(project);
  const level = project.drawingLevels.find((l) => l.id === activeLevelId);
  const combo = levelCombination(project, level);
  const levelEditable = !!level && (level.kind === "floor" || level.kind === "section" || level.kind === "elevation" || level.kind === "ceiling");
  const targets = designOptionTargets(project);
  const combos = designOptionCombinations(project);
  const state = levelCombinationState(project, level);
  const deleteCombo = combos.find((c) => c.id === deleting);
  const selIds = useMemo(() => designOptionIds(project, selectionDesignOptionIds(selection)), [project, selection]);
  const handlers: DesignOptionHandlers = {
    onAddDesignOptionSet: (name) => applyChange((p) => addDesignOptionSetOps(p, name).ops),
    onRenameDesignOptionSet: (setId, name) => applyChange((p) => renameDesignOptionSetOps(p, setId, name), `dopt-set-${setId}`),
    onAddDesignOption: (setId) => applyChange((p) => addDesignOptionOps(p, setId)),
    onRenameDesignOption: (setId, optionId, name) => applyChange((p) => renameDesignOptionOps(p, setId, optionId, name), `dopt-${setId}-${optionId}`),
    onSetPrimaryDesignOption: (setId, optionId) => applyChange((p) => setPrimaryOptionOps(p, setId, optionId)),
    onAcceptDesignOption: (setId, optionId) => applyChange((p) => acceptDesignOptionOps(p, setId, optionId)),
    onDeleteDesignOption: (setId, optionId) => applyChange((p) => deleteDesignOptionOps(p, setId, optionId)),
  };
  // Auge und Stift je Variante (Zeilen der Variantensätze).
  const view: DesignOptionViewControls = {
    visible: (setId) => visibleOption(project, level, draw, setId),
    edit: draw,
    eyeEnabled: levelEditable,
    onEye: (setId, optionId) => {
      if (!level) return;
      const r = eyeClick(project, level.id, draw, setId, optionId);
      if (r.ops.length) applyChange((p) => eyeClick(p, level.id, draw, setId, optionId).ops);
      if (r.draw !== draw) setDraw(r.draw);
    },
    onPen: (setId, optionId) => setDraw(penClick(project, draw, setId, optionId)),
  };
  const setOptions = (s: (typeof sets)[number]) =>
    s.options.map((o) => (
      <option key={o.id} value={o.id}>
        {o.name}
      </option>
    ));
  const targetOptions = (
    <>
      <option value="">{t("designOption.main")}</option>
      {targets.map((x) => (
        <option key={x.key} value={x.key}>
          {x.label}
        </option>
      ))}
    </>
  );
  return (
    <section className="reno-panel design-options-panel" data-testid="design-options-panel">
      {sets.length > 0 && (
        <>
          <div className="reno-block" data-testid="design-option-edit">
            <div className="reno-head">{t("designOption.edit.title")}</div>
            <div className={`rm-row dop-main-row${draw ? "" : " is-editing"}`}>
              <button
                type="button"
                className={`reno-icon-btn dop-pen${draw ? "" : " is-on"}`}
                aria-pressed={!draw}
                aria-label={t("designOption.pen.main")}
                title={t("designOption.pen.main")}
                data-testid="design-option-pen-main"
                onClick={() => setDraw(null)}
              >
                <span className="material-symbols-outlined" aria-hidden="true">{draw ? "edit" : "edit_square"}</span>
              </button>
              <span className="dop-main-name">{t("designOption.main")}</span>
            </div>
            <label className="reno-field dop-check">
              <input type="checkbox" checked={grey} data-testid="design-option-grey" onChange={(e) => setGrey(e.target.checked)} />
              <span>{t("designOption.edit.grey")}</span>
            </label>
            <label className="reno-field dop-check">
              <input type="checkbox" checked={lock} data-testid="design-option-lock" onChange={(e) => setLock(e.target.checked)} />
              <span>{t("designOption.edit.lock")}</span>
            </label>
            <div className="reno-hint">{t("designOption.edit.hint")}</div>
          </div>
          <div className="reno-block">
            <div className="reno-head">{t("designOption.sets.title")}</div>
            <DesignOptionsTab project={project} handlers={handlers} embedded view={view} />
          </div>
          <div className="reno-block">
            <div className="reno-head">{t("designOption.combinations.title")}</div>
            <div className="reno-field" data-testid="design-option-current">
              <span>{t("designOption.current")}</span>
              <strong className="design-option-current-name" data-testid="design-option-current-name">
                {state.kind === "named" ? state.name : t("designOption.customName")}
              </strong>
            </div>
            {combos.length === 0 && <div className="reno-hint">{t("designOption.combinations.empty")}</div>}
            {combos.map((c) => {
              const full = combinationChoice(project, c);
              const assigned = state.kind === "named" && state.id === c.id && state.assigned;
              return (
                <div key={c.id} className={`design-option-combination${assigned ? " is-assigned" : ""}`} data-testid="design-option-combination">
                  <div className="dop-combo-head">
                    <InlineName
                      value={c.name}
                      label={t("designOption.combination.name")}
                      editLabel={t("designOption.rename")}
                      testId="design-option-combination-name"
                      onCommit={(name) => applyChange((p) => renameCombinationOps(p, c.id, name), `dopt-comb-${c.id}`)}
                    />
                    <button
                      type="button"
                      className={`reno-icon-btn dop-assign${assigned ? " is-on" : ""}`}
                      disabled={!levelEditable || assigned}
                      title={assigned ? t("designOption.combination.assigned") : t("designOption.combination.assign")}
                      aria-label={assigned ? t("designOption.combination.assigned") : t("designOption.combination.assign")}
                      data-testid="design-option-combination-assign"
                      onClick={() => level && applyChange((p) => assignCombinationOps(p, level.id, c.id))}
                    >
                      <span className="material-symbols-outlined" aria-hidden="true">{assigned ? "check_circle" : "visibility"}</span>
                    </button>
                    <button type="button" className="reno-icon-btn" aria-label={t("designOption.combination.delete")} title={t("designOption.combination.delete")} data-testid="design-option-combination-delete" onClick={() => setDeleting(c.id)}>
                      <span className="material-symbols-outlined" aria-hidden="true">delete</span>
                    </button>
                  </div>
                  {sets.map((s) => (
                    <label key={s.id} className="reno-field dop-combo-set">
                      <span>{s.name}</span>
                      <select value={full[s.id] ?? ""} aria-label={`${c.name}: ${s.name}`} data-testid={`design-option-combination-${c.id}-${s.id}`} onChange={(e) => applyChange((p) => setCombinationChoiceOps(p, c.id, s.id, e.target.value))}>
                        {setOptions(s)}
                      </select>
                    </label>
                  ))}
                </div>
              );
            })}
            <button type="button" className="reno-add-btn" data-testid="design-option-combo-save" onClick={() => setSaving(true)}>
              {t("designOption.combination.save")}
            </button>
          </div>
          <div className="reno-block">
            <div className="reno-head">{t("designOption.selection", { n: selIds.length })}</div>
            <label className="reno-field">
              <span>{t("designOption.label")}</span>
              <select value={target} aria-label={t("designOption.label")} data-testid="design-option-target" onChange={(e) => setTarget(e.target.value)}>
                {targetOptions}
              </select>
            </label>
            <div className="dop-actions">
              <button type="button" className="reno-add-btn" disabled={!selIds.length} data-testid="design-option-assign" onClick={() => applyChange((p) => assignDesignOptionOps(p, selIds, parseTarget(target)))}>
                {t("designOption.assign")}
              </button>
              <button type="button" className="reno-add-btn" disabled={!selIds.length} data-testid="design-option-copy" onClick={() => applyChange((p) => copyToDesignOptionOps(p, selIds, parseTarget(target)))}>
                {t("designOption.copy")}
              </button>
            </div>
          </div>
        </>
      )}
      {sets.length === 0 && (
        <div className="reno-block">
          <div className="reno-head">{t("designOption.sets.title")}</div>
          <DesignOptionsTab project={project} handlers={handlers} embedded />
        </div>
      )}
      {sets.length > 0 && (
        <div className="reno-block">
          <button type="button" className="reno-add-btn" data-testid="design-option-compare-open" onClick={() => setShowCompare((v) => !v)}>
            {showCompare ? t("designOption.compare.hide") : t("designOption.compare.show")}
          </button>
          {showCompare && <DesignOptionCompareSection project={project} />}
        </div>
      )}
      {saving && (
        <PromptDialog
          title={t("designOption.combination.save")}
          label={t("designOption.combination.name")}
          defaultValue={nextCombinationName(project, t("designOption.combination.defaultName"))}
          onClose={() => setSaving(false)}
          onConfirm={(name) => {
            setSaving(false);
            applyChange((p) => addCombinationOps(p, name, combo).ops);
          }}
        />
      )}
      {deleteCombo && (
        <ConfirmDialog
          title={t("designOption.combination.delete")}
          message={t("designOption.combination.deleteMessage", { name: deleteCombo.name })}
          confirmLabel={t("designOption.combination.deleteConfirm")}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            setDeleting(null);
            applyChange((p) => deleteCombinationOps(p, deleteCombo.id));
          }}
        />
      )}
    </section>
  );
}