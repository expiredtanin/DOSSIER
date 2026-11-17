// [272] Ressourcen-Tab „Varianten“: Variantensätze (z. B. „Dachform“) mit ihren Varianten anlegen, umbenennen, löschen;
// Hauptvariante wählen; „Variante übernehmen“ (ihre Elemente ins Hauptmodell, die übrigen Varianten des Satzes werden
// gelöscht — ein Undo-Schritt). Reine Darstellung über Handler mit Werten (auch im macOS-Nebenfenster).

import { useState } from "react";
import { t } from "../../i18n";
import type { Project } from "../../model/types";
import { designOptionSets, primaryOption } from "../../core";

export interface DesignOptionHandlers {
  onAddDesignOptionSet?: (name: string) => void;
  onRenameDesignOptionSet?: (setId: string, name: string) => void;
  onAddDesignOption?: (setId: string) => void;
  onRenameDesignOption?: (setId: string, optionId: string, name: string) => void;
  onSetPrimaryDesignOption?: (setId: string, optionId: string) => void;
  /** Variante übernehmen: Elemente ins Hauptmodell, übrige Varianten des Satzes gelöscht, Satz weg. */
  onAcceptDesignOption?: (setId: string, optionId: string) => void;
  /** Satz (ohne `optionId`) bzw. Variante samt ihren Elementen löschen. */
  onDeleteDesignOption?: (setId: string, optionId?: string) => void;
}

/** Zahl der Elemente je Variante (Satz-Id → Varianten-Id → Anzahl). */
function counts(project: Project): Map<string, number> {
  const out = new Map<string, number>();
  const lists = [project.walls, project.openings, project.ceilings, project.roofs, project.stairs, project.columns, project.extrudedSolids, project.rooms, project.drawings2d];
  for (const list of lists) {
    for (const e of (list ?? []) as { designOption?: { set: string; option: string } }[]) {
      if (!e.designOption) continue;
      const k = `${e.designOption.set}/${e.designOption.option}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

export function DesignOptionsTab({ project, handlers }: { project: Project; handlers: DesignOptionHandlers }) {
  const sets = designOptionSets(project);
  const [newName, setNewName] = useState("");
  const n = counts(project);
  const add = () => {
    if (!handlers.onAddDesignOptionSet) return;
    handlers.onAddDesignOptionSet(newName.trim() || t("designOption.set.defaultName", { n: sets.length + 1 }));
    setNewName("");
  };
  return (
    <div className="rm-design-options" data-testid="rm-design-options">
      <h4 className="rm-subhead">{t("designOption.sets.title")}</h4>
      <p className="rm-hint">{t("designOption.sets.hint")}</p>
      {sets.length === 0 && <div className="rm-empty">{t("designOption.sets.empty")}</div>}
      {sets.map((s) => {
        const prim = primaryOption(s);
        return (
          <div key={s.id} className="rm-design-option-set" data-testid="rm-design-option-set">
            <div className="rm-row">
              <input
                type="text"
                value={s.name}
                aria-label={t("designOption.set")}
                disabled={!handlers.onRenameDesignOptionSet}
                onChange={(e) => handlers.onRenameDesignOptionSet?.(s.id, e.target.value)}
              />
              <button type="button" className="rm-icon-btn" title={t("designOption.option.add")} aria-label={t("designOption.option.add")} disabled={!handlers.onAddDesignOption} onClick={() => handlers.onAddDesignOption?.(s.id)} data-testid="rm-design-option-add">
                <span className="material-symbols-outlined" aria-hidden="true">add</span>
              </button>
              <button type="button" className="rm-icon-btn" title={t("designOption.set.delete")} aria-label={t("designOption.set.delete")} disabled={!handlers.onDeleteDesignOption} onClick={() => handlers.onDeleteDesignOption?.(s.id)}>
                <span className="material-symbols-outlined" aria-hidden="true">delete</span>
              </button>
            </div>
            {s.options.map((o) => (
              <div className="rm-row rm-design-option" key={o.id} data-testid="rm-design-option">
                <label className="rm-design-option-primary" title={t("designOption.primary")}>
                  <input type="radio" name={`primary-${s.id}`} checked={prim === o.id} disabled={!handlers.onSetPrimaryDesignOption} onChange={() => handlers.onSetPrimaryDesignOption?.(s.id, o.id)} aria-label={t("designOption.primary")} />
                </label>
                <input
                  type="text"
                  value={o.name}
                  aria-label={t("designOption.option")}
                  disabled={!handlers.onRenameDesignOption}
                  onChange={(e) => handlers.onRenameDesignOption?.(s.id, o.id, e.target.value)}
                />
                <span className="rm-design-option-count" title={t("designOption.count")}>
                  {n.get(`${s.id}/${o.id}`) ?? 0}
                </span>
                <button type="button" className="rm-add-btn" disabled={!handlers.onAcceptDesignOption} onClick={() => handlers.onAcceptDesignOption?.(s.id, o.id)} title={t("designOption.accept.hint")} data-testid="rm-design-option-accept">
                  {t("designOption.accept")}
                </button>
                <button type="button" className="rm-icon-btn" title={t("designOption.option.delete")} aria-label={t("designOption.option.delete")} disabled={!handlers.onDeleteDesignOption} onClick={() => handlers.onDeleteDesignOption?.(s.id, o.id)}>
                  <span className="material-symbols-outlined" aria-hidden="true">delete</span>
                </button>
              </div>
            ))}
          </div>
        );
      })}
      <div className="rm-row">
        <input type="text" value={newName} placeholder={t("designOption.set.placeholder")} aria-label={t("designOption.set.new")} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} data-testid="rm-design-option-set-name" />
        <button type="button" className="rm-add-btn" disabled={!handlers.onAddDesignOptionSet} onClick={add} data-testid="rm-design-option-set-add">
          {t("designOption.set.add")}
        </button>
      </div>
    </div>
  );
}
