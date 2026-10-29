// Dock-Panel „Verlauf" ([84]): die Undo-Schritte als Liste, jüngster oben, der aktuelle Stand
// markiert, Wiederholen-Schritte (noch nicht gültig) gedimmt darüber. Klick auf einen Eintrag springt
// dorthin (`jumpHistory`: ein Kern-Aufruf über mehrere Schritte). Die Beschriftungen liefert der Kern
// (`historyEntries`), Anzeigetext über `historyLabelText`.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useMemo } from "react";
import { t } from "../i18n";
import { useStore } from "../state/appStore";
import { historyLabelText } from "../state/historyLabels";

interface Entry {
  /** Undo-Tiefe, auf die ein Klick springt (0 = Ausgangsstand). */
  depth: number;
  text: string;
  future: boolean;
}

export function HistoryPanel() {
  const undoDepth = useStore((s) => s.undoDepth);
  const redoDepth = useStore((s) => s.redoDepth);
  const project = useStore((s) => s.project);
  const historyEntries = useStore((s) => s.historyEntries);
  const jumpHistory = useStore((s) => s.jumpHistory);

  const entries = useMemo<Entry[]>(() => {
    const { undo, redo } = historyEntries();
    const list: Entry[] = [{ depth: 0, text: t("history.start"), future: false }];
    undo.forEach((l, i) => list.push({ depth: i + 1, text: historyLabelText(l), future: false }));
    redo.forEach((l, i) => list.push({ depth: undo.length + i + 1, text: historyLabelText(l), future: true }));
    return list.reverse();
    // `project` ändert sich mit jedem Schritt; die Tiefen fangen Sprünge ab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyEntries, undoDepth, redoDepth, project]);

  if (undoDepth + redoDepth === 0) {
    return (
      <section className="nav-group" data-testid="history-panel">
        <div className="nav-empty">{t("history.empty")}</div>
      </section>
    );
  }
  return (
    <section className="nav-group" data-testid="history-panel">
      <ul className="nav-list" role="listbox" aria-label={t("nav.history")} style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {entries.map((e) => {
          const current = e.depth === undoDepth;
          return (
            <li
              key={e.depth}
              role="option"
              aria-selected={current}
              className={`history-row${current ? " active" : ""}${e.future ? " future" : ""}`}
              data-testid="history-entry"
              data-depth={e.depth}
              title={current ? t("history.current") : undefined}
              onClick={() => jumpHistory(e.depth)}
            >
              <span className="nav-label">{e.text}</span>
              {current && <span aria-hidden="true">◀</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
