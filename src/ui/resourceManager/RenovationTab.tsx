// [271] Ressourcen-Tab „Umbau“: Etappen (Name, Reihenfolge, hinzufügen/entfernen) und Umbau-Farben je Status
// (Füllung, Linie, gestrichelt; Vorgabe SIA 400: Bestand grau, Abbruch gelb gestrichelt, Neu rot).
// Reine Darstellung über Handler (wie die anderen Tabs, auch im macOS-Nebenfenster). [275] Farben als Farbe oder Stift
// über den gemeinsamen Editor (`ui/RenovationStyleEditor.tsx`, wie im Umbau-Panel).

import { t } from "../../i18n";
import type { Project, RenovationPhase, RenovationStyles } from "../../model/types";
import { newPhaseId, renovationPhases, resolvedRenovationStyles } from "../../core";
import { RenovationStyleEditor } from "../RenovationStyleEditor";

export interface RenovationHandlers {
  /** Etappen-Liste ersetzen (Elemente einer entfernten Etappe verlieren sie). */
  onSetRenovationPhases?: (phases: RenovationPhase[]) => void;
  /** Umbau-Farben ersetzen (`undefined` = SIA-Vorgabe). */
  onSetRenovationStyles?: (styles: RenovationStyles | undefined) => void;
}

export function RenovationTab({ project, handlers }: { project: Project; handlers: RenovationHandlers }) {
  const phases = renovationPhases(project);
  const styles = project.renovation?.styles;
  const setPhases = handlers.onSetRenovationPhases;
  const setStyles = handlers.onSetRenovationStyles;
  const move = (i: number, d: number) => {
    const j = i + d;
    if (!setPhases || j < 0 || j >= phases.length) return;
    const next = [...phases];
    [next[i], next[j]] = [next[j], next[i]];
    setPhases(next);
  };
  return (
    <div className="rm-renovation" data-testid="rm-renovation">
      <h4 className="rm-subhead">{t("renovation.phases.title")}</h4>
      <p className="rm-hint">{t("renovation.phases.hint")}</p>
      {phases.length === 0 && <div className="rm-empty">{t("renovation.phases.empty")}</div>}
      {phases.map((ph, i) => (
        <div className="rm-row" key={ph.id} data-testid="rm-renovation-phase">
          <input
            type="text"
            value={ph.name}
            aria-label={t("renovation.phase")}
            disabled={!setPhases}
            onChange={(e) => setPhases?.(phases.map((x) => (x.id === ph.id ? { ...x, name: e.target.value } : x)))}
          />
          <button type="button" className="rm-icon-btn" disabled={!setPhases || i === 0} title={t("renovation.phases.up")} aria-label={t("renovation.phases.up")} onClick={() => move(i, -1)}>
            ▲
          </button>
          <button type="button" className="rm-icon-btn" disabled={!setPhases || i === phases.length - 1} title={t("renovation.phases.down")} aria-label={t("renovation.phases.down")} onClick={() => move(i, 1)}>
            ▼
          </button>
          <button type="button" className="rm-icon-btn" disabled={!setPhases} title={t("renovation.phases.remove")} aria-label={t("renovation.phases.remove")} onClick={() => setPhases?.(phases.filter((x) => x.id !== ph.id))}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="rm-add-btn"
        disabled={!setPhases}
        data-testid="rm-renovation-add-phase"
        onClick={() => setPhases?.([...phases, { id: newPhaseId(project), name: t("renovation.phases.defaultName", { n: String(phases.length + 1) }) }])}
      >
        {t("renovation.phases.add")}
      </button>

      <h4 className="rm-subhead">{t("renovation.styles.title")}</h4>
      <p className="rm-hint">{t("renovation.styles.hint")}</p>
      <RenovationStyleEditor
        project={project}
        styles={styles}
        shown={resolvedRenovationStyles(project).project}
        testId="rm-renovation-style"
        dashedFor={["existing", "demolish", "new"]}
        disabled={!setStyles}
        onChange={(next) => setStyles?.(next)}
      />
    </div>
  );
}
