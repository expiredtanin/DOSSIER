// Zeichnungs-Reiterleiste — Kopfzeile über der Zeichenfläche ([136]).
//
// Ein Reiter ist eine OFFENE Ansicht (UI-Zustand, state/viewTabs.ts), kein Ausschnitt: beliebig viele,
// auch mehrere aus demselben Ausschnitt oder ganz ohne Ausschnitt. Jeder Reiter merkt sich seinen
// Darstellungszustand (Geschoss/Schnitt/Ansicht, Massstab, Sichtbarkeit, Overrides, Kamera); ein Klick
// wechselt dorthin. „+" öffnet einen neuen Reiter mit der aktuellen Ansicht, „×" schliesst nur den Reiter
// (nie den letzten) — Ausschnitte werden ausschliesslich im Panel „Ausschnitte" angelegt/gelöscht. Der
// Titel ist der Name des Ausschnitts, aus dem der Reiter geöffnet wurde, sonst der Name der Zeichnungsebene.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import type { Project } from "./model/types";
import { tabTitle, type ViewTab, type ViewTabsState } from "./state/viewTabs";
import { t } from "./i18n";

/** Handler-Bündel der Reiterleiste (Host-Handler in state/usePanelHostBase.ts). */
export interface ViewSnapshotTabsHandlers {
  tabs: ViewTabsState;
  onActivate: (tabId: string) => void;
  onNew: () => void;
  onClose: (tabId: string) => void;
  /** Titel eines Reiters ohne Ausschnitt (Zeichnungskombination bzw. Zeichnungsebene). */
  autoName: (levelId?: string) => string;
}

export function DrawingTabs({
  project,
  handlers,
}: {
  project: Project;
  handlers: ViewSnapshotTabsHandlers;
}) {
  const snapshots = project.viewSnapshots ?? [];
  const { tabs, onActivate, onNew, onClose, autoName } = handlers;
  const title = (tab: ViewTab) =>
    tabTitle(tab, snapshots, (tb) => autoName(tb.id === tabs.activeId ? undefined : tb.state?.activeLevelId));
  const closable = tabs.tabs.length > 1;

  return (
    <div className="drawing-tabs" role="tablist" aria-label={t("tabs.drawings")}>
      {tabs.tabs.map((tab) => {
        const active = tab.id === tabs.activeId;
        const name = title(tab);
        return (
          <div key={tab.id} className={`drawing-tab${active ? " active" : ""}`} data-tab-id={tab.id}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="drawing-tab-label"
              onClick={() => onActivate(tab.id)}
              title={name}
            >
              {name}
            </button>
            {closable && (
              <button
                type="button"
                className="drawing-tab-close"
                aria-label={t("tabs.close", { name })}
                title={t("tabs.close", { name })}
                onClick={() => onClose(tab.id)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="drawing-tab-add"
        aria-label={t("tabs.add")}
        title={t("tabs.add")}
        onClick={() => onNew()}
      >
        +
      </button>
    </div>
  );
}
