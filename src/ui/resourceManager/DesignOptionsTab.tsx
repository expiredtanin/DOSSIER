// [272] Ressourcen-Tab „Varianten“: Variantensätze (z. B. „Dachform“) mit ihren Varianten anlegen, umbenennen, löschen;
// Hauptvariante wählen; „Variante übernehmen“ (ihre Elemente ins Hauptmodell, die übrigen Varianten des Satzes werden
// gelöscht — ein Undo-Schritt). Reine Darstellung über Handler mit Werten (auch im macOS-Nebenfenster).

import { useState } from "react";
import { t } from "../../i18n";
import type { Project } from "../../model/types";
import { designOptionSets, primaryOption } from "../../core";
import { ConfirmDialog } from "../ConfirmDialog";
import { EyeIcon } from "../EyeIcon";
import { InlineName } from "../InlineName";

/**
 * [272] Auge und Stift je Variante (nur im Dock-Panel „Varianten“, wie Archicads Design-Options-Manager): Auge = in der
 * Kombination der aktiven Ansicht sichtbar (je Satz genau eine), Stift = Bearbeitungsvariante (neue Elemente landen in ihr).
 */
export interface DesignOptionViewControls {
  /** Sichtbare Variante des Satzes (Stift geht vor). */
  visible: (setId: string) => string | undefined;
  /** Bearbeitungsvariante (`null` = Hauptmodell). */
  edit: { set: string; option: string } | null;
  /** Die aktive Ansicht kann eine Kombination tragen (sonst Augen gesperrt). */
  eyeEnabled: boolean;
  onEye: (setId: string, optionId: string) => void;
  onPen: (setId: string, optionId: string) => void;
}

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
  const lists = [project.walls, project.openings, project.ceilings, project.roofs, project.stairs, project.columns, project.beams, project.extrudedSolids, project.rooms, project.drawings2d];
  for (const list of lists) {
    for (const e of (list ?? []) as { designOption?: { set: string; option: string } }[]) {
      if (!e.designOption) continue;
      const k = `${e.designOption.set}/${e.designOption.option}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

export function DesignOptionsTab({ project, handlers, embedded, view }: { project: Project; handlers: DesignOptionHandlers; /** Im Dock-Panel: ohne eigene Überschrift. */ embedded?: boolean; /** [272] Auge und Stift je Variante (nur im Dock-Panel). */ view?: DesignOptionViewControls }) {
  const sets = designOptionSets(project);
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<{ setId: string; optionId?: string } | null>(null);
  const n = counts(project);
  const add = () => {
    if (!handlers.onAddDesignOptionSet) return;
    handlers.onAddDesignOptionSet(newName.trim() || t("designOption.set.defaultName", { n: sets.length + 1 }));
    setNewName("");
  };
  const delSet = deleting ? sets.find((s) => s.id === deleting.setId) : undefined;
  const delOption = delSet && deleting?.optionId ? delSet.options.find((o) => o.id === deleting.optionId) : undefined;
  // Zahl der Elemente, die mit dem Satz bzw. der Variante verschwinden.
  const delCount = !delSet ? 0 : delOption ? (n.get(`${delSet.id}/${delOption.id}`) ?? 0) : delSet.options.reduce((a, o) => a + (n.get(`${delSet.id}/${o.id}`) ?? 0), 0);
  return (
    <div className="rm-design-options" data-testid="rm-design-options">
      {!embedded && <h4 className="rm-subhead">{t("designOption.sets.title")}</h4>}
      <p className="rm-hint">{t("designOption.sets.hint")}</p>
      {sets.length === 0 && <div className="rm-empty">{t("designOption.sets.empty")}</div>}
      {sets.map((s) => {
        const prim = primaryOption(s);
        return (
          <div key={s.id} className="rm-design-option-set" data-testid="rm-design-option-set">
            <div className="rm-row rm-set-head">
              <InlineName
                className="rm-set-name"
                value={s.name}
                label={t("designOption.set")}
                editLabel={t("designOption.rename")}
                disabled={!handlers.onRenameDesignOptionSet}
                testId="rm-design-option-set-title"
                onCommit={(name) => handlers.onRenameDesignOptionSet?.(s.id, name)}
              />
              <button type="button" className="rm-icon-btn" title={t("designOption.option.add")} aria-label={t("designOption.option.add")} disabled={!handlers.onAddDesignOption} onClick={() => handlers.onAddDesignOption?.(s.id)} data-testid="rm-design-option-add">
                <span className="material-symbols-outlined" aria-hidden="true">add</span>
              </button>
              <button type="button" className="rm-icon-btn" title={t("designOption.set.delete")} aria-label={t("designOption.set.delete")} disabled={!handlers.onDeleteDesignOption} onClick={() => setDeleting({ setId: s.id })} data-testid="rm-design-option-set-delete">
                <span className="material-symbols-outlined" aria-hidden="true">delete</span>
              </button>
            </div>
            {s.options.map((o) => {
              const shown = view?.visible(s.id) === o.id;
              const editing = view?.edit?.set === s.id && view.edit.option === o.id;
              return (
              <div className={`rm-row rm-design-option${editing ? " is-editing" : ""}`} key={o.id} data-testid="rm-design-option">
                {view && (
                  <>
                    <button
                      type="button"
                      className={`eye dop-eye${shown ? " is-on" : ""}`}
                      disabled={!view.eyeEnabled && !shown}
                      aria-pressed={shown}
                      aria-label={`${t("designOption.eye")}: ${o.name}`}
                      title={shown ? t("designOption.eye.on") : t("designOption.eye.off")}
                      data-testid={`design-option-eye-${s.id}-${o.id}`}
                      onClick={() => view.onEye(s.id, o.id)}
                    >
                      <EyeIcon open={shown} />
                    </button>
                    <button
                      type="button"
                      className={`reno-icon-btn dop-pen${editing ? " is-on" : ""}`}
                      aria-pressed={editing}
                      aria-label={`${t("designOption.pen")}: ${o.name}`}
                      title={editing ? t("designOption.pen.on") : t("designOption.pen.off")}
                      data-testid={`design-option-pen-${s.id}-${o.id}`}
                      onClick={() => view.onPen(s.id, o.id)}
                    >
                      <span className="material-symbols-outlined" aria-hidden="true">{editing ? "edit_square" : "edit"}</span>
                    </button>
                  </>
                )}
                <input
                  type="radio"
                  className="rm-design-option-primary"
                  name={`primary-${s.id}`}
                  checked={prim === o.id}
                  disabled={!handlers.onSetPrimaryDesignOption}
                  title={t("designOption.primary")}
                  aria-label={`${t("designOption.primary")}: ${o.name}`}
                  onChange={() => handlers.onSetPrimaryDesignOption?.(s.id, o.id)}
                />
                <InlineName
                  className="rm-option-name"
                  value={o.name}
                  label={t("designOption.option")}
                  editLabel={t("designOption.rename")}
                  disabled={!handlers.onRenameDesignOption}
                  testId="rm-design-option-title"
                  onCommit={(name) => handlers.onRenameDesignOption?.(s.id, o.id, name)}
                />
                <span className="rm-design-option-count" title={t("designOption.count")}>
                  {n.get(`${s.id}/${o.id}`) ?? 0}
                </span>
                <button type="button" className="rm-add-btn" disabled={!handlers.onAcceptDesignOption} onClick={() => handlers.onAcceptDesignOption?.(s.id, o.id)} title={t("designOption.accept.hint")} data-testid="rm-design-option-accept">
                  {t("designOption.accept")}
                </button>
                <button type="button" className="rm-icon-btn" title={t("designOption.option.delete")} aria-label={t("designOption.option.delete")} disabled={!handlers.onDeleteDesignOption} onClick={() => setDeleting({ setId: s.id, optionId: o.id })} data-testid="rm-design-option-delete">
                  <span className="material-symbols-outlined" aria-hidden="true">delete</span>
                </button>
              </div>
              );
            })}
          </div>
        );
      })}
      <div className="rm-row rm-add-row">
        <input type="text" className="rm-input" value={newName} placeholder={t("designOption.set.placeholder")} aria-label={t("designOption.set.new")} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} data-testid="rm-design-option-set-name" />
        <button type="button" className="rm-add-btn" disabled={!handlers.onAddDesignOptionSet} onClick={add} data-testid="rm-design-option-set-add">
          {t("designOption.set.add")}
        </button>
      </div>
      {delSet && (
        <ConfirmDialog
          title={delOption ? t("designOption.option.delete") : t("designOption.set.delete")}
          message={delOption ? t("designOption.option.deleteMessage", { name: delOption.name, n: delCount }) : t("designOption.set.deleteMessage", { name: delSet.name, n: delCount })}
          confirmLabel={t("designOption.delete.confirm")}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const d = deleting;
            setDeleting(null);
            if (d) handlers.onDeleteDesignOption?.(d.setId, d.optionId);
          }}
        />
      )}
    </div>
  );
}
