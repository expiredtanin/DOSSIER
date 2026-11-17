// [272] Chip „Variante: …“ in der Statusleiste (neben „Umbau“): zeigt die Variantenkombination der aktiven Ansicht (nur die
// Abweichungen von den Hauptvarianten) und öffnet per Klick das Panel „Varianten“, in dem man sie einstellt. Nur sichtbar,
// wenn das Projekt Variantensätze hat; bei wenig Platz wandert es mit Pausfolie und „Umbau“ in „⋯“ ([263]).

import { t } from "../i18n";
import { useStore } from "../state/appStore";
import { combinationSuffix, designOptionTargets } from "../core";

export function DesignOptionControl() {
  const project = useStore((s) => s.project);
  const activeLevelId = useStore((s) => s.activeLevelId);
  const draw = useStore((s) => s.drawDesignOption);
  if (!project.designOptionSets?.length) return null;
  const level = project.drawingLevels.find((l) => l.id === activeLevelId);
  const suffix = combinationSuffix(project, level?.designOptions);
  const drawKey = draw ? `${draw.set}/${draw.option}` : "";
  const drawLabel = designOptionTargets(project).find((x) => x.key === drawKey)?.label ?? t("designOption.main");
  const shown = suffix || t("designOption.primaryCombination");
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
