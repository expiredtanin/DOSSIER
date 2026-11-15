// [260] Auswahl „Im Grundriss“ für Fenster-/Türtypen: gemeinsam für die Ressourcen (Typ-Tabs) und den
// Fenster-/Türeditor im Bereich „Objekt“ (eine Quelle für Werte und Texte).

import { t } from "../i18n";

export type OpeningPlanMode = "symbolisch" | "geschnitten";

/** Leer = wie Modelldarstellung (Vorgabe der Ansicht). */
export function planModeOptions(): { value: "" | OpeningPlanMode; label: string }[] {
  return [
    { value: "", label: t("objinfo.opening.planMode.fromModelView") },
    { value: "symbolisch", label: t("objinfo.opening.planMode.symbolisch") },
    { value: "geschnitten", label: t("objinfo.opening.planMode.geschnitten") },
  ];
}

export const planModeFromValue = (v: string): OpeningPlanMode | undefined => (v === "" ? undefined : (v as OpeningPlanMode));
