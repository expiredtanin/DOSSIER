// [34] Ansichtsvorlagen in der Plan-Erzeugung: wie eine Vorlage (`Project.viewTemplates`) auf Schnitt, Ansicht
// und Grundriss wirkt, wenn sie nicht über den Anzeigezustand der aktiven Ansicht kommt — auf Blatt-Viewports
// (verknüpfte Vorlage des Ausschnitts) und in der CLI (`--template`, verknüpfte Vorlage der Ebene).
// Reine Logik; Kern-Gegenstück für die Blatt-Puffer: `sheet_viewports::snapshot_project`.

import type { DrawingLevel, Project, ViewTemplate } from "../model/types";
import type { DetailLevel } from "../model/viewTypes";

/** Ebenen-Felder, die eine Vorlage setzt (fehlt das Vorlagen-Feld, bleibt die Ansicht unberührt). */
export const TEMPLATE_LEVEL_KEYS = ["cutHeight", "viewTop", "viewBottom", "viewDepth", "shadows", "hiddenLines", "sketch", "cutHatch", "floorFinish", "showTerrain", "modelViewOptionId"] as const;

/** Teilobjekt für die Ebene aus den gesetzten Feldern der Vorlage. */
export function templateLevelPatch(t: ViewTemplate): Partial<DrawingLevel> {
  const out: Record<string, unknown> = {};
  for (const k of TEMPLATE_LEVEL_KEYS) if (t[k] !== undefined) out[k] = t[k];
  return out as Partial<DrawingLevel>;
}

/** Die verknüpfte Vorlage einer Ansicht/eines Ausschnitts (nur bei `templateLinked`). */
export function linkedViewTemplate(
  project: Pick<Project, "viewTemplates">,
  target: { templateId?: string | null; templateLinked?: boolean | null } | undefined,
): ViewTemplate | undefined {
  if (!target?.templateId || !target.templateLinked) return undefined;
  return project.viewTemplates?.find((t) => t.id === target.templateId);
}

/**
 * Das Projekt, wie die Vorlage es für die Ebene `levelId` sieht: Ebenen-Felder der Vorlage und ihre
 * Strichstärken-Skalierung. `rules`: auch die Override-Regeln der Vorlage einschalten (alle übrigen aus) —
 * für Wege, die die Regeln aus dem Projekt lesen (CLI); Viewports übergeben sie ausdrücklich.
 */
export function projectWithTemplate(project: Project, levelId: string, t: ViewTemplate, rules = false): Project {
  const patch = templateLevelPatch(t);
  let p: Project = { ...project, drawingLevels: project.drawingLevels.map((l) => (l.id === levelId ? { ...l, ...patch } : l)) };
  if (t.scaleLineWeights !== undefined) p = { ...p, scaleLineWeights: t.scaleLineWeights };
  const ids = t.enabledOverrideRuleIds;
  if (rules && ids) p = { ...p, overrideRules: (p.overrideRules ?? []).map((r) => ({ ...r, enabled: ids.includes(r.id) })) };
  return p;
}

/** Anzeigewerte, die eine Vorlage zusätzlich zu den Ebenen-Feldern vorgibt (CLI, Blatt). */
export interface TemplateDisplay {
  detail: DetailLevel | undefined;
  scaleDenominator: number | undefined;
  mono: boolean | undefined;
  /** Kategorie-Codes, die die Vorlage ausblendet. */
  hiddenCodes: string[];
}

export function templateDisplay(t: ViewTemplate | undefined): TemplateDisplay {
  return {
    detail: t?.detail,
    scaleDenominator: t?.scaleDenominator,
    mono: t?.mono,
    hiddenCodes: Object.entries(t?.layerVisibility ?? {})
      .filter(([, v]) => v === false)
      .map(([code]) => code),
  };
}
