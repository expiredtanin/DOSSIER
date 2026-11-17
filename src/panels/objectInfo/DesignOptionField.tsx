// [272] Objekt-Info und Objekteinstellungen: „Variante“ — Hauptmodell oder eine Variante eines Satzes für die Auswahl.
// Mehrfachauswahl: alle gewählten Elemente in einem Undo-Schritt; verschiedene Werte zeigen „gemischt“. Nur mit
// Variantensätzen im Projekt.

import { useMemo } from "react";
import { t } from "../../i18n";
import { assignDesignOptionOps, commonDesignOption, designOptionIds, designOptionSets, designOptionTargets, parseTarget } from "../../core";
import { useStore } from "../../state/appStore";
import type { Selection } from "../../state/selection";
import { Dropdown } from "../../ui/Dropdown";
import { selectionRenovationIds } from "../../state/renovationHook";

const MIXED = "__mixed";

/** Ids der Auswahl, die einer Variante angehören können (Bauteile, Räume, 2D-Zeichnungen). */
export function selectionDesignOptionIds(sel: Selection): string[] {
  return [...selectionRenovationIds(sel), ...sel.drawings];
}

export function DesignOptionField() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const applyChange = useStore((s) => s.applyChange);
  const ids = useMemo(() => designOptionIds(project, selectionDesignOptionIds(selection)), [project, selection]);
  const common = useMemo(() => commonDesignOption(project, ids), [project, ids]);
  if (ids.length === 0 || designOptionSets(project).length === 0) return null;
  const value = common === "mixed" || common === null ? MIXED : common;
  const options = [
    ...(value === MIXED ? [{ value: MIXED, label: t("renovation.mixed") }] : []),
    { value: "", label: t("designOption.main") },
    ...designOptionTargets(project).map((x) => ({ value: x.key, label: x.label })),
  ];
  return (
    <div className="objinfo-field" data-testid="objinfo-design-option">
      <span className="objinfo-flabel">{t("designOption.label")}</span>
      <Dropdown
        value={value}
        onChange={(v) => {
          if (v === MIXED) return;
          applyChange((p) => assignDesignOptionOps(p, ids, parseTarget(v)));
        }}
        options={options}
        title={t("designOption.label")}
        width={150}
      />
    </div>
  );
}
