// Ressourcen-Tab „Ansichtsvorlagen" ([34]): Vorlagen anlegen (aus der aktiven Ansicht), duplizieren,
// umbenennen, löschen, bearbeiten und auf Ansichten/Ausschnitte anwenden (einmal oder verknüpft).
// Die Logik (Ops, Weitergabe an verknüpfte Ansichten) liegt in `state/viewTemplates.ts`; die
// Handler kommen aus der App, ein Aufruf = ein Undo-Schritt.

import { useState } from "react";
import type { Project, ViewTemplate } from "../../model/types";
import { flattenCategories } from "../../model/layers";
import { t } from "../../i18n";
import { DeleteButton, FieldRow, NumberField } from "./fields";

/** Ziel einer Anwendung: aktive Ansicht, ein Geschoss/Schnitt/Ansicht oder ein Ausschnitt. */
export type ViewTemplateTarget = { kind: "active" } | { kind: "level"; id: string } | { kind: "snapshot"; id: string };

export interface ViewTemplateHandlers {
  onAddViewTemplate?: () => void;
  onDuplicateViewTemplate?: (id: string) => void;
  /** Teiländerung; `null` = Feld entfernen (die Vorlage lässt die Einstellung dann unberührt). */
  onPatchViewTemplate?: (id: string, patch: Record<string, unknown>) => void;
  onDeleteViewTemplate?: (id: string) => void;
  onApplyViewTemplate?: (id: string, target: ViewTemplateTarget, linked: boolean) => void;
}

const DISPLAY_MODES = ["all_force", "all", "active", "grey", "grey_locked", "locked"] as const;

/** Einstellung mit Ein-/Ausschalter: aus = die Vorlage lässt sie unberührt. */
function Optional({ label, on, onToggle, children }: { label: string; on: boolean; onToggle: (on: boolean) => void; children: React.ReactNode }) {
  return (
    <div className="res-field">
      <span className="res-field-label">
        <label>
          <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} /> {label}
        </label>
      </span>
      <span className="res-field-control">{on ? children : <span className="res-joint-none">–</span>}</span>
    </div>
  );
}

function TemplateDetail({
  tpl,
  project,
  h,
}: {
  tpl: ViewTemplate;
  project: Project;
  h: ViewTemplateHandlers;
}) {
  const [target, setTarget] = useState("active");
  const patch = (p: Record<string, unknown>) => h.onPatchViewTemplate?.(tpl.id, p);
  const num = (key: "cutHeight" | "viewTop" | "viewBottom" | "viewDepth", label: string, dflt: number) => (
    <Optional label={label} on={tpl[key] !== undefined} onToggle={(on) => patch({ [key]: on ? dflt : null })}>
      <NumberField value={tpl[key] ?? dflt} step={0.1} onChange={(v) => patch({ [key]: v })} />
    </Optional>
  );
  const bool = (key: "mono" | "shadows" | "hiddenLines" | "scaleLineWeights", label: string) => (
    <Optional label={label} on={tpl[key] !== undefined} onToggle={(on) => patch({ [key]: on ? false : null })}>
      <input type="checkbox" checked={tpl[key] === true} onChange={(e) => patch({ [key]: e.target.checked })} />
    </Optional>
  );
  const cats = flattenCategories(project.layers);
  const levels = project.drawingLevels.filter((l) => l.kind !== "drawing");
  const parseTarget = (v: string): ViewTemplateTarget =>
    v === "active" ? { kind: "active" } : v.startsWith("level:") ? { kind: "level", id: v.slice(6) } : { kind: "snapshot", id: v.slice(5) };
  return (
    <div className="res-detail" data-testid="view-template-detail">
      <FieldRow label={t("resources.viewTemplates.name")}>
        <input className="res-input" aria-label={t("resources.viewTemplates.name")} value={tpl.name} onChange={(e) => patch({ name: e.target.value })} />
      </FieldRow>
      <Optional label={t("resources.viewTemplates.detail")} on={tpl.detail !== undefined} onToggle={(on) => patch({ detail: on ? "mittel" : null })}>
        <select className="res-input" value={tpl.detail ?? "mittel"} onChange={(e) => patch({ detail: e.target.value })}>
          {(["grob", "mittel", "fein"] as const).map((d) => (
            <option key={d} value={d}>
              {t(`topbar.detail.${d}`)}
            </option>
          ))}
        </select>
      </Optional>
      <Optional label={t("resources.viewTemplates.scale")} on={tpl.scaleDenominator !== undefined} onToggle={(on) => patch({ scaleDenominator: on ? 100 : null })}>
        <NumberField value={tpl.scaleDenominator ?? 100} step={50} min={1} onChange={(v) => patch({ scaleDenominator: Math.max(1, v) })} />
      </Optional>
      <Optional label={t("resources.viewTemplates.displayMode")} on={tpl.displayMode !== undefined} onToggle={(on) => patch({ displayMode: on ? "all" : null })}>
        <select className="res-input" value={tpl.displayMode ?? "all"} onChange={(e) => patch({ displayMode: e.target.value })}>
          {DISPLAY_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`display.${m}`)}
            </option>
          ))}
        </select>
      </Optional>
      {bool("mono", t("resources.viewTemplates.mono"))}
      {bool("shadows", t("resources.viewTemplates.shadows"))}
      {bool("hiddenLines", t("resources.viewTemplates.hiddenLines"))}
      {bool("scaleLineWeights", t("resources.viewTemplates.scaleLineWeights"))}
      <div className="res-hint">{t("resources.viewTemplates.rangeHint")}</div>
      {num("cutHeight", t("resources.viewTemplates.cutHeight"), 1.0)}
      {num("viewTop", t("resources.viewTemplates.viewTop"), 2.5)}
      {num("viewBottom", t("resources.viewTemplates.viewBottom"), 0)}
      {num("viewDepth", t("resources.viewTemplates.viewDepth"), 0.5)}
      <div className="res-hint">{t("resources.viewTemplates.categories")}</div>
      <div className="res-vt-cats" data-testid="view-template-categories">
        {cats.map((c) => {
          const v = tpl.layerVisibility?.[c.code];
          return (
            <FieldRow key={c.code} label={`${c.code} ${c.name}`}>
              <select
                className="res-input"
                aria-label={`${c.code} ${c.name}`}
                value={v === undefined ? "keep" : v ? "show" : "hide"}
                onChange={(e) => {
                  const next = { ...(tpl.layerVisibility ?? {}) };
                  if (e.target.value === "keep") delete next[c.code];
                  else next[c.code] = e.target.value === "show";
                  patch({ layerVisibility: Object.keys(next).length ? next : null });
                }}
              >
                <option value="keep">{t("resources.viewTemplates.cat.keep")}</option>
                <option value="show">{t("resources.viewTemplates.cat.show")}</option>
                <option value="hide">{t("resources.viewTemplates.cat.hide")}</option>
              </select>
            </FieldRow>
          );
        })}
      </div>
      <div className="res-hint">{t("resources.viewTemplates.apply")}</div>
      <FieldRow label={t("resources.viewTemplates.target")}>
        <select className="res-input" aria-label={t("resources.viewTemplates.target")} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="active">{t("resources.viewTemplates.target.active")}</option>
          {levels.map((l) => (
            <option key={l.id} value={`level:${l.id}`}>
              {l.name}
            </option>
          ))}
          {(project.viewSnapshots ?? []).map((s) => (
            <option key={s.id} value={`snap:${s.id}`}>
              {t("resources.viewTemplates.target.snapshot", { name: s.name })}
            </option>
          ))}
        </select>
      </FieldRow>
      <div className="res-vt-apply" style={{ display: "flex", gap: 8 }}>
        <button className="res-add" data-testid="view-template-apply-once" disabled={!h.onApplyViewTemplate} onClick={() => h.onApplyViewTemplate?.(tpl.id, parseTarget(target), false)}>
          {t("resources.viewTemplates.applyOnce")}
        </button>
        <button className="res-add" data-testid="view-template-apply-linked" disabled={!h.onApplyViewTemplate} onClick={() => h.onApplyViewTemplate?.(tpl.id, parseTarget(target), true)}>
          {t("resources.viewTemplates.applyLinked")}
        </button>
      </div>
    </div>
  );
}

export function ViewTemplatesTab({ project, handlers }: { project: Project; handlers: ViewTemplateHandlers }) {
  const list = project.viewTemplates ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = list.find((x) => x.id === selectedId) ?? list[0];
  const usedBy = (id: string) =>
    project.drawingLevels.filter((l) => l.templateId === id && l.templateLinked).length +
    (project.viewSnapshots ?? []).filter((s) => s.templateId === id && s.templateLinked).length;
  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.viewTemplates.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {list.map((x) => (
            <div
              key={x.id}
              role="button"
              tabIndex={0}
              data-testid="view-template-row"
              className={`res-md-row${selected?.id === x.id ? " active" : ""}`}
              style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
              onClick={() => setSelectedId(x.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setSelectedId(x.id);
              }}
            >
              <span className="res-md-row-name" style={{ flex: 1 }}>
                {x.name}
                {usedBy(x.id) > 0 && <span style={{ display: "block", fontSize: "0.85em", opacity: 0.65 }}>{t("resources.viewTemplates.linkedCount", { n: usedBy(x.id) })}</span>}
              </span>
              <button
                type="button"
                className="res-layer-btn"
                title={t("resources.viewTemplates.duplicate")}
                onClick={(e) => {
                  e.stopPropagation();
                  handlers.onDuplicateViewTemplate?.(x.id);
                }}
              >
                ⧉
              </button>
              <DeleteButton title={t("resources.viewTemplates.delete")} onClick={() => handlers.onDeleteViewTemplate?.(x.id)} />
            </div>
          ))}
          {list.length === 0 && <div className="res-md-empty">{t("resources.viewTemplates.empty")}</div>}
          <div className="res-md-listfoot">
            <button className="res-add" data-testid="view-template-add" onClick={() => handlers.onAddViewTemplate?.()} disabled={!handlers.onAddViewTemplate}>
              <span className="res-add-plus">+</span> {t("resources.viewTemplates.fromActive")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? <TemplateDetail key={selected.id} tpl={selected} project={project} h={handlers} /> : <div className="res-md-empty">{t("resources.viewTemplates.empty")}</div>}
        </div>
      </div>
    </div>
  );
}
