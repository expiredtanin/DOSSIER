// [271][272] Ansicht für Exporte und Rendering aus dem Zustand der App: Umbaufilter, Etappe und Variantenkombination der
// aktiven Ebene (wie das 3D-Fenster sie zeigt), dazu die lesbare Fassung für Dialoge. Die Rechnung selbst: `export/exportView.ts`.

import { exportViewLabels, levelExportView, type ExportView } from "../core";
import { getState } from "./appStore";
import { renovationFilterLabel } from "./renovationHook";

export interface ActiveExportView {
  view: ExportView;
  labels: { renovation: string | null; combination: string | null };
}

/** Ansicht der aktiven Ebene (`activeLevelId`) des aktuellen Projekts. */
export function activeExportView(): ActiveExportView {
  const st = getState();
  const view = levelExportView(st.project, st.activeLevelId);
  const own = st.project.renovation?.filters ?? [];
  return { view, labels: exportViewLabels(st.project, view, (id) => renovationFilterLabel(id, own)) };
}
