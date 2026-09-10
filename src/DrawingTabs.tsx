// Ausschnitt-Tab-Leiste — Kopfzeile über der Zeichenfläche.
//
// Jeder Tab ist ein gespeicherter Ausschnitt (ViewSnapshot, DOSSIER A2,
// s. state/viewSnapshots.ts + panels/ViewSnapshotsPanel.tsx): aktive
// Zeichnungsebene + Ebenen-/Zeichnungsebenen-Sichtbarkeit + Overrides + Ansicht.
// Ein Klick lädt ihn — identisch zum Panel „Ausschnitte" (dieselben Handler).
// „+" sichert den aktuellen Stand als neuen Tab; der Name wird automatisch
// bestimmt (aktive Zeichnungskombination, falls ihre Sichtbarkeits-Map exakt
// passt, sonst das aktive Blatt) — kein Tipp-Dialog, wie ein Browser-Tab.
// „×" löscht einen Tab; mindestens einer bleibt immer erhalten (fehlt der
// letzte, wird beim nächsten Mount automatisch einer aus dem aktuellen Stand
// nachgezogen).
//
// Ersetzt die frühere Ein-Tab-je-Geschoss-Leiste: ein Ausschnitt kann JEDE
// Zeichnungsebenen-Art referenzieren (Geschoss, Schnitt, Ansicht, Zeichnung),
// nicht nur Geschosse — man kann also in einem Tab im Schnitt arbeiten und im
// nächsten im Grundriss, jeweils mit eigener Ebenen-/Zeichnungssichtbarkeit.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect } from "react";
import type { Project } from "./model/types";
import { t } from "./i18n";

/** Handler-Bündel der Ausschnitt-Tab-Leiste — identische Semantik wie die
 *  gleichnamigen Host-Handler in panels/host.ts (dieselbe Quelle der Wahrheit). */
export interface ViewSnapshotTabsHandlers {
  /** Id des aktuell angewählten Ausschnitts (aktiver Tab) oder `null`, wenn
   *  der Live-Zustand von jedem gespeicherten Ausschnitt abweicht. */
  selectedId: string | null;
  /** Lädt einen Ausschnitt (Klick auf einen Tab). */
  onApply: (id: string) => void;
  /** Sichert den aktuellen Stand als neuen Ausschnitt (automatischer Name);
   *  liefert dessen Id. */
  onCaptureAuto: () => string;
  /** Löscht einen Ausschnitt. */
  onDelete: (id: string) => void;
}

export function DrawingTabs({
  project,
  handlers,
}: {
  project: Project;
  handlers: ViewSnapshotTabsHandlers;
}) {
  const snapshots = project.viewSnapshots ?? [];
  const { selectedId, onApply, onCaptureAuto, onDelete } = handlers;

  // Es muss immer mindestens ein Tab existieren (Nutzer-Vorgabe): ein frisches
  // oder altes Projekt ohne einen einzigen Ausschnitt bekommt beim ersten
  // Mount automatisch einen aus dem aktuellen Stand.
  useEffect(() => {
    if (snapshots.length === 0) onCaptureAuto();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshots.length]);

  if (snapshots.length === 0) return null;

  return (
    <div className="drawing-tabs" role="tablist" aria-label={t("tabs.drawings")}>
      {snapshots.map((s) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={s.id === selectedId}
          className={`drawing-tab${s.id === selectedId ? " active" : ""}`}
          onClick={() => onApply(s.id)}
          title={s.name}
        >
          <span className="drawing-tab-label">{s.name}</span>
          {snapshots.length > 1 && (
            <span
              className="drawing-tab-close"
              role="button"
              aria-label={t("tabs.delete")}
              title={t("tabs.delete")}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
            >
              ×
            </span>
          )}
        </button>
      ))}
      <button
        type="button"
        className="drawing-tab-add"
        aria-label={t("tabs.add")}
        title={t("tabs.add")}
        onClick={() => onCaptureAuto()}
      >
        +
      </button>
    </div>
  );
}
