// Handler und Wirkung der Ansichtsvorlagen ([34]) in der App: Ressourcen-Tab „Ansichtsvorlagen" und
// der Abgleich des Anzeigezustands (Detail, Massstab, Kategorien, Override-Regeln, Darstellungsmodus,
// Schwarz-Weiss) mit der verknüpften Vorlage der aktiven Ansicht. Die reine Logik liegt in
// `viewTemplates.ts`; hier nur die Verdrahtung mit Store und Ansichts-Zustand.

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { applyOverrideRuleEnabled } from "./viewSnapshots";
import { fieldOps, findItem } from "../core";
import type { CoreOp } from "../core";
import { uniqueId } from "../tools/types";
import { t } from "../i18n";
import type { DrawingLevel, Project, ViewTemplate } from "../model/types";
import type { DetailLevel } from "../model/viewTypes";
import type { DisplayMode } from "../panels/types";
import type { ViewTemplateHandlers, ViewTemplateTarget } from "../ui/resourceManager/ViewTemplatesTab";
import type { PlanViewHandle } from "../views/plan/PlanView";
import {
  addTemplateOps,
  applyToLevelOps,
  applyToSnapshotOps,
  captureTemplate,
  deleteTemplateOps,
  duplicateTemplateOps,
  linkedTemplate,
  patchTemplateOps,
  uiPatch,
  type ViewTemplateUi,
} from "./viewTemplates";

interface Deps {
  project: Project;
  applyChange: (ops: CoreOp[] | ((p: Project) => CoreOp[]), coalesceKey?: string) => void;
  groupChanges: (fn: () => void, key?: string) => void;
  activeLevel: DrawingLevel | undefined;
  detail: DetailLevel;
  setDetail: (d: DetailLevel) => void;
  scaleDenominator: number;
  setScaleDenominator: (n: number) => void;
  snapshotLayerVisibility: () => Record<string, boolean>;
  applyLayerVisibility: (codes: Record<string, boolean>) => void;
  mono: boolean;
  setMono: (mono: boolean) => void;
  displayMode: DisplayMode;
  setDisplayMode: (m: DisplayMode) => void;
  planViewRef: RefObject<PlanViewHandle | null>;
}

export function useViewTemplateHandlers(d: Deps): ViewTemplateHandlers {
  const { project, applyChange, groupChanges, activeLevel } = d;

  const liveUi = (): ViewTemplateUi => ({
    detail: d.detail,
    scaleDenominator: d.scaleDenominator,
    layerVisibility: d.snapshotLayerVisibility(),
    enabledOverrideRuleIds: (project.overrideRules ?? []).filter((r) => r.enabled).map((r) => r.id),
    displayMode: d.displayMode,
    mono: d.mono,
    scaleLineWeights: project.scaleLineWeights === true,
  });

  /** Anzeigezustand der aktiven Ansicht an die Vorlage angleichen (nur Abweichendes). */
  const syncUi = (tpl: ViewTemplate) => {
    const patch = uiPatch(tpl, liveUi());
    if (Object.keys(patch).length === 0) return;
    groupChanges(() => {
      if (patch.layerVisibility) d.applyLayerVisibility(patch.layerVisibility);
      const ids = patch.enabledOverrideRuleIds;
      if (ids) applyChange((p) => fieldOps(p, "overrideRules", applyOverrideRuleEnabled(p.overrideRules ?? [], ids)));
    });
    if (patch.detail) d.setDetail(patch.detail);
    if (patch.scaleDenominator) {
      d.setScaleDenominator(patch.scaleDenominator);
      requestAnimationFrame(() => d.planViewRef.current?.applyScale(patch.scaleDenominator!));
    }
    if (patch.displayMode) d.setDisplayMode(patch.displayMode as DisplayMode);
    if (patch.mono !== undefined) d.setMono(patch.mono);
    if (patch.scaleLineWeights !== undefined) applyChange((p) => fieldOps(p, "scaleLineWeights", patch.scaleLineWeights));
  };

  // Verknüpfte Vorlage der aktiven Ansicht: bei Wechsel der Ansicht und bei jeder Änderung der Vorlage
  // anwenden. Der Schlüssel enthält den Inhalt der Vorlage, damit Handänderungen an den Kategorien
  // nicht ständig überschrieben werden (nur Vorlage/Ansicht wechseln lösen aus).
  const tpl = linkedTemplate(project, activeLevel);
  const key = tpl ? `${activeLevel?.id}|${JSON.stringify(tpl)}` : "";
  const last = useRef("");
  useEffect(() => {
    if (key === last.current) return;
    last.current = key;
    if (tpl) syncUi(tpl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const onApply = (id: string, target: ViewTemplateTarget, linked: boolean) => {
    const tplNow = findItem(project, "viewTemplates", id);
    if (!tplNow) return;
    const levelId = target.kind === "active" ? activeLevel?.id : target.kind === "level" ? target.id : undefined;
    applyChange((p) => (target.kind === "snapshot" ? applyToSnapshotOps(p, id, target.id, linked) : levelId ? applyToLevelOps(p, id, levelId, linked) : []));
    // Wirkt das Ziel auf die aktive Ansicht, gleich den Anzeigezustand mitziehen.
    if (target.kind !== "snapshot" && levelId === activeLevel?.id) syncUi(tplNow);
  };

  return {
    onAddViewTemplate: () => {
      const n = (project.viewTemplates ?? []).length + 1;
      const tplNew = captureTemplate(uniqueId("vt"), t("resources.viewTemplates.defaultName", { n }), activeLevel, liveUi());
      applyChange(addTemplateOps(tplNew));
    },
    onDuplicateViewTemplate: (id) => {
      const src = findItem(project, "viewTemplates", id);
      if (!src) return;
      applyChange((p) => duplicateTemplateOps(p, id, uniqueId("vt"), t("resources.viewTemplates.copyName", { name: src.name })));
    },
    onPatchViewTemplate: (id, patch) => {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) clean[k] = v === null ? undefined : v;
      // Tippen im Namen/Zahlenfeld = ein Undo-Schritt je Feld.
      const first = Object.keys(clean)[0] ?? "";
      applyChange((p) => patchTemplateOps(p, id, clean as Partial<ViewTemplate>), `viewTemplate:${id}:${first}`);
    },
    onDeleteViewTemplate: (id) => applyChange((p) => deleteTemplateOps(p, id)),
    onApplyViewTemplate: onApply,
  };
}
