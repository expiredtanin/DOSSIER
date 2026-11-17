// [271] Objekt-Info und Objekteinstellungen: „Umbau“ — Status (Bestand, Abbruch, Neu) und Etappe der Auswahl.
// Mehrfachauswahl: alle gewählten Bauteile in einem Undo-Schritt; verschiedene Werte zeigen „gemischt“.

import { memo } from "react";
import { t } from "../../i18n";
import type { RenovationStatus } from "../../model/types";
import { RENOVATION_STATUSES, commonBuildUp, parseBuildUpKey, renovationPair, setBuildUpOps } from "../../core";
import { getState, useStore } from "../../state/appStore";
import { RenovationStrip } from "../../ui/RenovationStrip";
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
      <BuildUpField />
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

const NO_TYPES: readonly { id: string; name: string; renovationTarget?: string }[] = [];

/**
 * [274] „Neuer Aufbau (Sanierung)“ der gewählten Wände: keiner, wie Typ (Sanierungstyp des Wandtyps) oder ein anderer
 * Wandtyp (Ausnahme). Mehrfachauswahl in einem Undo-Schritt; bei gemeinsamem Wandtyp der Streifen Alt/Neu/Ergebnis.
 */
const BuildUpField = memo(function BuildUpField() {
  const types = useStore((s) => s.project.wallTypes) ?? NO_TYPES;
  const applyChange = useStore((s) => s.applyChange);
  const wallIds = useStore((s) => s.selection.walls);
  // Gemeinsamer Aufbau und gemeinsamer Wandtyp als Text: rendert nur bei echter Änderung neu.
  const key = useStore((s) => {
    const set = new Set(s.selection.walls);
    const ts = new Set(s.project.walls.filter((w) => set.has(w.id)).map((w) => w.wallTypeId));
    return JSON.stringify([commonBuildUp(s.project, s.selection.walls), ts.size === 1 ? [...ts][0] : null]);
  });
  const [common, typeId] = JSON.parse(key) as [string | null, string | null];
  if (common === null || wallIds.length === 0) return null;
  const own = typeId ? types.find((x) => x.id === typeId) : undefined;
  const ownTarget = own?.renovationTarget ? types.find((x) => x.id === own.renovationTarget) : undefined;
  const options = [
    ...(common === "mixed" ? [{ value: MIXED, label: t("renovation.mixed") }] : []),
    { value: "", label: t("renovation.buildUp.none") },
    { value: "type", label: ownTarget ? t("renovation.buildUp.type", { name: ownTarget.name }) : t("renovation.buildUp.typeMissing") },
    ...types.filter((x) => x.id !== typeId).map((x) => ({ value: `t:${x.id}`, label: t("renovation.buildUp.other", { name: x.name }) })),
  ];
  const value = common === "mixed" ? MIXED : common;
  const b = parseBuildUpKey(value === MIXED ? "" : value);
  const target = b.kind === "other" ? b.typeId : b.kind === "type" ? ownTarget?.id : undefined;
  const pair = typeId && target ? renovationPair(getState().project, typeId, target) : null;
  return (
    <>
      <div className="objinfo-field" data-testid="objinfo-renovation-buildup">
        <span className="objinfo-flabel" title={t("renovation.buildUp.hint")}>
          {t("renovation.buildUp")}
        </span>
        <Dropdown
          value={value}
          onChange={(v) => {
            if (v === MIXED) return;
            applyChange((p) => setBuildUpOps(p, wallIds, parseBuildUpKey(v)));
          }}
          options={options}
          title={t("renovation.buildUp")}
          width={150}
        />
      </div>
      {pair && (
        <div className="objinfo-field reno-strip-field" data-testid="objinfo-renovation-strip">
          <RenovationStrip pair={pair} width={140} />
        </div>
      )}
    </>
  );
});
