// [272] Chip „Variante: …“ in der Statusleiste (neben „Umbau“): zeigt die Variantenkombination der aktiven Ansicht (nur die
// Abweichungen von den Hauptvarianten) und öffnet per Klick das Panel „Varianten“, in dem man sie einstellt. Nur sichtbar,
// wenn das Projekt Variantensätze hat; bei wenig Platz wandert es mit Pausfolie und „Umbau“ in „⋯“ ([263]).
// Im Bearbeitungsmodus (Stift auf einer Variante) zeigt es deutlich „Bearbeite: Dachform B“ (hervorgehoben).

import { t } from "../i18n";
import { useStore } from "../state/appStore";
import { combinationSuffix, designOptionTargets, levelCombination, levelCombinationState } from "../core";

/** Material-Symbol des Bearbeitungsmodus (Ligatur, kein UI-Text). */
const EDITING_ICON = "edit_square";

export function DesignOptionControl() {
  const project = useStore((s) => s.project);
  const activeLevelId = useStore((s) => s.activeLevelId);
  const draw = useStore((s) => s.drawDesignOption);
  if (!project.designOptionSets?.length) return null;
  const level = project.drawingLevels.find((l) => l.id === activeLevelId);
  // Name der benannten Kombination (zugewiesen oder gleiche Wahl), sonst „Eigene: Abweichungen“ bzw. die Hauptvarianten.
  const state = levelCombinationState(project, level);
  const diff = combinationSuffix(project, levelCombination(project, level));
  const suffix = state.kind === "named" ? state.name : diff ? t("designOption.custom", { combination: diff }) : "";
  const drawKey = draw ? `${draw.set}/${draw.option}` : "";
  const drawLabel = designOptionTargets(project).find((x) => x.key === drawKey)?.label ?? t("designOption.main");
  const shown = suffix || t("designOption.primaryCombination");
  const editSet = draw ? project.designOptionSets.find((s) => s.id === draw.set) : undefined;
  const editOption = editSet?.options.find((o) => o.id === draw?.option);
  if (editSet && editOption) {
    const name = `${editSet.name} ${editOption.name}`.trim();
    return (
      <button
        type="button"
        className="sb-toggle sb-renovation-on sb-design-editing"
        data-testid="design-option-toggle"
        title={t("designOption.editing.hint", { option: name })}
        onClick={() => window.dispatchEvent(new CustomEvent("dossier:reveal-panel", { detail: "design-options" }))}
      >
        <span className="material-symbols-outlined" aria-hidden="true">{EDITING_ICON}</span>
        {t("designOption.editing", { option: name })}
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`sb-toggle${suffix || draw ? " sb-renovation-on" : ""}`}
      data-testid="design-option-toggle"
      title={t("designOption.hint", { combination: shown, draw: drawLabel })}
      onClick={() => window.dispatchEvent(new CustomEvent("dossier:reveal-panel", { detail: "design-options" }))}
    >
      {t("designOption.short", { combination: shown })}
    </button>
  );
}
