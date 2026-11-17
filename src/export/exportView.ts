// [271][272] Ansicht eines Exports: Umbaufilter, Etappe und Variantenkombination, die ein Export bzw. Rendering übernimmt.
// EIN Ort für IFC, glTF/OBJ/STL, Blender-Paket und Cycles-Szene — der Kern wertet sie über den Text der Abfrage aus
// (`renovation::view_from_text`: `{"renovation", "renovationPhase", "designOptions"}`; ohne Angabe Hauptvarianten, kein Filter).

import type { Project } from "../model/types";
import { combinationLabel, combinationNameFor, combinationSuffix, resolveCombination, storedChoice } from "../model/designOptions";

export interface ExportView {
  /** Umbaufilter (Id oder Name; eingebaut `bestand`, `abbruch`, `neubau`, `umbauplan`, `endzustand`). */
  renovation?: string;
  /** Etappe („bis n“). */
  renovationPhase?: string;
  /** Variantenkombination (Satz-Id → Varianten-Id); fehlende Sätze gelten als Hauptvariante. */
  designOptions?: Record<string, string>;
}

/** Ansicht der Ebene `levelId` (Umbaufilter und Kombination, wie sie das 3D-Fenster dieser Ebene zeigt); ohne Ebene leer. */
export function levelExportView(project: Project, levelId: string | null | undefined): ExportView {
  const level = project.drawingLevels.find((l) => l.id === levelId);
  if (!level) return {};
  const view: ExportView = {};
  if (level.renovationFilter) {
    view.renovation = level.renovationFilter;
    if (level.renovationPhase) view.renovationPhase = level.renovationPhase;
  }
  const choice = storedChoice(project, level);
  if (choice && Object.keys(choice).length > 0) view.designOptions = { ...choice };
  return view;
}

/** Wirkt die Ansicht (Filter oder gewählte Kombination)? */
export function hasExportView(view: ExportView | null | undefined): boolean {
  return !!view && (!!view.renovation || !!view.designOptions);
}

/** Der Text der Kern-Abfragen (JSON); leer, wenn die Ansicht nichts ändert. `extra` kommt dazu (z. B. `iso` beim IFC). */
export function exportViewText(view: ExportView | null | undefined, extra: Record<string, unknown> = {}): string {
  const body: Record<string, unknown> = { ...extra };
  if (view?.renovation) {
    body.renovation = view.renovation;
    if (view.renovationPhase) body.renovationPhase = view.renovationPhase;
  }
  if (view?.designOptions && Object.keys(view.designOptions).length > 0) body.designOptions = view.designOptions;
  return Object.keys(body).length > 0 ? JSON.stringify(body) : "";
}

/** Felder einer Ansicht für die Optionen der Cycles-Szene (JSON an den Kern). */
export function exportViewFields(view: ExportView | null | undefined): Record<string, unknown> {
  const text = exportViewText(view);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * Lesbare Fassung für Dialoge: Filter-Anzeigename (über `filterName`, mit Etappe) und Kombination (Name einer gespeicherten
 * Kombination, sonst „Satz Variante, …“ der Abweichungen von der Hauptvariante); `null` = nicht gesetzt.
 */
export function exportViewLabels(project: Project, view: ExportView, filterName: (id: string) => string): { renovation: string | null; combination: string | null } {
  const phase = view.renovationPhase ? (project.renovation?.phases?.find((p) => p.id === view.renovationPhase)?.name ?? view.renovationPhase) : "";
  const full = view.designOptions ? resolveCombination(project, view.designOptions) : null;
  return {
    renovation: view.renovation ? filterName(view.renovation) + (phase ? ` (${phase})` : "") : null,
    combination: full ? (combinationNameFor(project, full) ?? (combinationSuffix(project, full) || combinationLabel(project, full))) || null : null,
  };
}
