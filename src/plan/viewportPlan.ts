// [115] Inhalt eines Layout-Viewports: der Plan der Ebene, auf die sein Ausschnitt zeigt — Geschoss und
// Zeichnung wie bisher über `generatePlan`, Schnitt und Ansicht wie in der Schnitt-/Ansichts-Ansicht
// (`SectionPlanView`): abgeleitete Projektion aus dem Kern, automatische Koten und die eigenen
// 2D-Elemente der Ebene. Vorher rechneten Viewports nur Grundrisse — ein Schnitt-Ausschnitt auf dem
// Blatt zeigte bloss seine 2D-Elemente. Nur Zusammensetzen vorhandener Kern-Abfragen.

import type { DetailLevel } from "../model/viewTypes";
import type { Project, ViewTemplate } from "../model/types";
import { withDocument } from "../core/document";
import { linkedViewTemplate, projectWithTemplate } from "./viewTemplate";
import { generatePlan, type Plan, type Primitive } from "./generatePlan";
import { computeSection, generateSectionPlan } from "./toSection";
import { generateElevationPlan } from "./toElevation";
import { levelMarkerPrimitives, levelMarksEnabled } from "./levelMarkers";

/**
 * [140] Tusche (Schwarz-Weiss) für einen Viewport: Standard wie in der App; Farbe nur, wenn die
 * Ansichtsvorlage des Ausschnitts ausdrücklich `mono: false` setzt (Kern: `sheet_viewports::snapshot_mono`).
 */
export function snapshotMono(project: Pick<Project, "viewTemplates">, snap: { templateId?: string | null }): boolean {
  if (!snap.templateId) return true;
  return project.viewTemplates?.find((t) => t.id === snap.templateId)?.mono !== false;
}

/**
 * [33] Eingeschaltete Override-Regeln eines Viewports (Kern: `sheet_viewports::snapshot_rule_ids`): die der
 * verknüpften Ansichtsvorlage, sonst die des Ausschnitts; legen beide nichts fest, `undefined` = Schalter im
 * Projekt. So zeigt ein Blatt seinen Ausschnitt mit dessen Regeln, nicht mit denen der aktiven Ansicht.
 */
export function snapshotOverrideRuleIds(
  project: Pick<Project, "viewTemplates">,
  snap: { templateId?: string | null; templateLinked?: boolean | null; enabledOverrideRuleIds?: string[] | null },
): string[] | undefined {
  const tpl = snap.templateId && snap.templateLinked ? project.viewTemplates?.find((t) => t.id === snap.templateId) : undefined;
  return tpl?.enabledOverrideRuleIds ?? snap.enabledOverrideRuleIds ?? undefined;
}

/** [34] Verknüpfte Ansichtsvorlage eines Ausschnitts, für {@link viewportLevelPlan} (Kern: `sheet_viewports::snapshot_template`). */
export function snapshotTemplate(
  project: Pick<Project, "viewTemplates">,
  snap: { templateId?: string | null; templateLinked?: boolean | null },
): ViewTemplate | undefined {
  return linkedViewTemplate(project, snap);
}

const EMPTY: Plan = { primitives: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };

/**
 * Plan der Ebene `levelId` für einen Layout-Viewport bzw. dessen PDF (`forPrint`: `noPrint`-Elemente
 * entfallen; `mono`: Tusche, s. {@link snapshotMono}). Schnitte brauchen die truck-Körper und sind darum asynchron.
 */
export async function viewportLevelPlan(
  project: Project,
  levelId: string,
  visibleCodes: Set<string>,
  detail: DetailLevel | undefined,
  scaleDenominator: number,
  forPrint = false,
  mono = true,
  /** [33] Eingeschaltete Override-Regeln ({@link snapshotOverrideRuleIds}); fehlt = Schalter im Projekt. */
  overrideRuleIds?: readonly string[] | null,
  /** [34] Verknüpfte Ansichtsvorlage des Ausschnitts: ihre Ebenen-Felder (verdeckte Kanten, Schnittflächen
   * schraffiert, Schatten, Skizzenstil …) und Detailgrad gelten für diesen Viewport (Kern: `sheet_viewports::snapshot_project`). */
  template?: ViewTemplate | null,
): Promise<Plan> {
  if (!template) return levelPlan(project, levelId, visibleCodes, detail, scaleDenominator, forPrint, mono, overrideRuleIds);
  const tp = projectWithTemplate(project, levelId, template);
  return withDocument(tp, () => levelPlan(tp, levelId, visibleCodes, template.detail ?? detail, scaleDenominator, forPrint, mono, overrideRuleIds));
}

async function levelPlan(
  project: Project,
  levelId: string,
  visibleCodes: Set<string>,
  detail: DetailLevel | undefined,
  scaleDenominator: number,
  forPrint: boolean,
  mono: boolean,
  overrideRuleIds: readonly string[] | null | undefined,
): Promise<Plan> {
  const level = project.drawingLevels.find((l) => l.id === levelId);
  if (!level) return EMPTY;
  if (level.kind !== "section" && level.kind !== "elevation") {
    return generatePlan(project, levelId, visibleCodes, undefined, detail, false, mono, true, scaleDenominator, forPrint, false, overrideRuleIds);
  }
  let raw: Plan | null;
  if (level.kind === "section") {
    const out = await computeSection(project, level);
    raw = out
      ? generateSectionPlan(out, mono, { hiddenLines: level.hiddenLines, visibleCodes, openings: true, scaleDenominator, detail, overrideRuleIds })
      : null;
  } else {
    raw = generateElevationPlan(project, level, { visibleCodes, scaleDenominator, mono, overrideRuleIds });
  }
  if (!raw || raw.primitives.length === 0) return EMPTY;
  const own = generatePlan(project, level.id, visibleCodes, undefined, detail, false, mono, false, scaleDenominator, forPrint, false, overrideRuleIds);
  const marks = levelMarksEnabled(level) ? levelMarkerPrimitives(project, raw.bounds) : [];
  const b = { ...raw.bounds };
  const grow = (x: number, y: number) => {
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  };
  if (own.primitives.length > 0) {
    grow(own.bounds.minX, own.bounds.minY);
    grow(own.bounds.maxX, own.bounds.maxY);
  }
  for (const pr of marks) if (pr.kind === "line") grow(pr.a.x, pr.a.y);
  const primitives: Primitive[] = [...raw.primitives, ...marks, ...own.primitives];
  return { primitives, bounds: b };
}
