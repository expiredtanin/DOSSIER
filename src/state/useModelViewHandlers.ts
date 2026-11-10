// [173] Handler des Ressourcen-Tabs „Modelldarstellung" und der Wahl in der Werkzeugleiste. Die reine
// Logik (Ops) liegt in `modelViews.ts`; hier nur die Verdrahtung mit dem Store. Handler lesen das Projekt
// beim Aufruf; ein Aufruf = ein Undo-Schritt (Tippen im Namen: einer je Feld).

import { getState } from "./appStore";
import type { CoreOp } from "../core";
import { uniqueId } from "../tools/types";
import { t } from "../i18n";
import type { Project } from "../model/types";
import type { DetailLevel } from "../model/viewTypes";
import type { ModelViewHandlers } from "../ui/resourceManager/ModelViewsTab";
import {
  addModelViewOps,
  deleteModelViewOps,
  duplicateModelViewOps,
  isBuiltinModelView,
  modelViewBase,
  newModelView,
  renameModelViewOps,
  selectModelViewOps,
  setModelViewBaseOps,
  setModelViewOptionOps,
  uniqueModelViewName,
} from "./modelViews";

type ApplyChange = (ops: CoreOp[] | ((p: Project) => CoreOp[]), coalesceKey?: string) => void;

export function modelViewHandlers(applyChange: ApplyChange, detail: () => DetailLevel): ModelViewHandlers {
  return {
    onAddModelView: () => {
      const p = getState().project;
      applyChange(addModelViewOps(newModelView(uniqueId("mv"), uniqueModelViewName(p.modelViewOptions, t("resources.modelViews.newName")), detail())));
    },
    onDuplicateModelView: (id) => {
      const p = getState().project;
      const src = isBuiltinModelView(id) ? t(`topbar.detail.${id}`) : p.modelViewOptions?.find((m) => m.id === id)?.name;
      if (src === undefined) return;
      applyChange((q) => duplicateModelViewOps(q, id, uniqueId("mv"), uniqueModelViewName(q.modelViewOptions, t("resources.modelViews.copyOf", { name: src }))));
    },
    onRenameModelView: (id, name) => applyChange((p) => renameModelViewOps(p, id, name), `mv-name-${id}`),
    onDeleteModelView: (id) => applyChange((p) => deleteModelViewOps(p, id)),
    onSetModelViewBase: (id, base) => applyChange((p) => setModelViewBaseOps(p, id, base ?? undefined)),
    onSetModelViewOption: (id, section, key, value) => applyChange((p) => setModelViewOptionOps(p, id, section, key, value ?? undefined)),
  };
}

/**
 * Wahl in der Werkzeugleiste: die Stufe der aktiven Ansicht (Ebenen-Feld) und der Detailgrad der Anzeige
 * (3D, Schnitt) = Basis der Stufe — ein Undo-Schritt für die Ebene, der Detailgrad ist Anzeigezustand.
 */
export function selectModelView(applyChange: ApplyChange, setDetail: (d: DetailLevel) => void, levelId: string, id: string): void {
  const p = getState().project;
  const base = modelViewBase(p, id);
  if (base) setDetail(base);
  applyChange((q) => selectModelViewOps(q, levelId, id));
}
