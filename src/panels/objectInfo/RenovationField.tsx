// [271] Objekt-Info und Objekteinstellungen: „Umbau“ — Status (Bestand, Abbruch, Neu) und Etappe der Auswahl.
// Mehrfachauswahl: alle gewählten Bauteile in einem Undo-Schritt; verschiedene Werte zeigen „gemischt“.

import { useMemo } from "react";
import { t } from "../../i18n";
import type { RenovationStatus } from "../../model/types";
import { commonRenovation, renovatableIds, renovationPhases, RENOVATION_STATUSES, setRenovationOps } from "../../core";
import { useStore } from "../../state/appStore";
import type { Selection } from "../../state/selection";
import { Dropdown } from "../../ui/Dropdown";

const MIXED = "__mixed";
const NO_PHASE = "";

/** Ids der Auswahl, die einen Umbau-Status tragen (Wände, Öffnungen, Decken, Dächer, Treppen, Stützen, Körper, Räume). */
export function selectionRenovationIds(sel: Selection): string[] {
  return [...sel.walls, ...sel.openings, ...sel.ceilings, ...sel.roofs, ...sel.stairs, ...sel.columns, ...sel.solids, ...sel.rooms];
}

export function RenovationField() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const applyChange = useStore((s) => s.applyChange);
  const ids = useMemo(() => renovatableIds(project, selectionRenovationIds(selection)), [project, selection]);
  const common = useMemo(() => commonRenovation(project, ids), [project, ids]);
  if (ids.length === 0) return null;
  const phases = renovationPhases(project);
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
            applyChange((p) => setRenovationOps(p, ids, v as RenovationStatus));
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
              applyChange((p) => setRenovationOps(p, ids, undefined, v === NO_PHASE ? null : v));
            }}
            options={phaseOptions}
            title={t("renovation.phase")}
            width={150}
          />
        </div>
      )}
    </>
  );
}
