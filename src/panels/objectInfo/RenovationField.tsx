// [271] Objekt-Info und Objekteinstellungen: „Umbau“ — Status (Bestand, Abbruch, Neu) und Etappe der Auswahl.
// Mehrfachauswahl: alle gewählten Bauteile in einem Undo-Schritt; verschiedene Werte zeigen „gemischt“.

import { memo } from "react";
import { t } from "../../i18n";
import type { RenovationStatus } from "../../model/types";
import { RENOVATION_STATUSES } from "../../core";
import { useStore } from "../../state/appStore";
import { useRenovationSelection } from "../../state/renovationHook";
import { Dropdown } from "../../ui/Dropdown";

const NO_PHASES: readonly { id: string; name: string }[] = [];
const MIXED = "__mixed";
const NO_PHASE = "";

/** `memo`: ohne Props rendert das Feld nur bei geänderter Auswahl/Status neu, nicht bei jeder Op des Eltern-Panels ([121]). */
export const RenovationField = memo(function RenovationField() {
  const phases = useStore((s) => s.project.renovation?.phases) ?? NO_PHASES;
  const { ids, common, setStatus, setPhase } = useRenovationSelection();
  if (ids.length === 0) return null;
  const statusValue = common.status === "mixed" || common.status === null ? MIXED : common.status;
  const phaseValue = common.phase === "mixed" ? MIXED : (common.phase ?? NO_PHASE);
  const statusOptions = [
    ...(statusValue === MIXED ? [{ value: MIXED, label: t("renovation.mixed") }] : []),
    ...RENOVATION_STATUSES.map((s) => ({ value: s, label: t(`renovation.status.${s}`) })),
  ];
  const phaseOptions = [
    ...(phaseValue === MIXED ? [{ value: MIXED, label: t("renovation.mixed") }] : []),
    { value: NO_PHASE, label: t("renovation.phase.none") },
    ...phases.map((p) => ({ value: p.id, label: p.name })),
  ];
  return (
    <>
      <div className="objinfo-field" data-testid="objinfo-renovation">
        <span className="objinfo-flabel">{t("renovation.label")}</span>
        <Dropdown
          value={statusValue}
          onChange={(v) => {
            if (v === MIXED) return;
            setStatus(v as RenovationStatus);
          }}
          options={statusOptions}
          title={t("renovation.label")}
          width={150}
        />
      </div>
      {phases.length > 0 && (
        <div className="objinfo-field" data-testid="objinfo-renovation-phase">
          <span className="objinfo-flabel">{t("renovation.phase")}</span>
          <Dropdown
            value={phaseValue}
            onChange={(v) => {
              if (v === MIXED) return;
              setPhase(v === NO_PHASE ? null : v);
            }}
            options={phaseOptions}
            title={t("renovation.phase")}
            width={150}
          />
        </div>
      )}
    </>
  );
});
