// [115] Inhalt eines Layout-Viewports: der Plan der Ebene, auf die sein Ausschnitt zeigt — Geschoss und
// Zeichnung wie bisher über `generatePlan`, Schnitt und Ansicht wie in der Schnitt-/Ansichts-Ansicht
// (`SectionPlanView`): abgeleitete Projektion aus dem Kern, automatische Koten und die eigenen
// 2D-Elemente der Ebene. Vorher rechneten Viewports nur Grundrisse — ein Schnitt-Ausschnitt auf dem
// Blatt zeigte bloss seine 2D-Elemente. Nur Zusammensetzen vorhandener Kern-Abfragen.

import type { DetailLevel } from "../model/viewTypes";
import type { Project, ViewTemplate } from "../model/types";
import { withDocument } from "../core/document";
import { storedChoice } from "../model/designOptions";
import { linkedViewTemplate, projectWithTemplate } from "./viewTemplate";
import { generatePlan, type Plan, type Primitive } from "./generatePlan";
import { computeSection, generateSectionPlan } from "./toSection";
import { generateElevationPlan } from "./toElevation";
import { levelMarkerPrimitives, levelMarksEnabled } from "./levelMarkers";
import { isDoc3dSnapshot, snapshotAxoPlan } from "./toAxo";
import type { ViewSnapshot } from "../model/types";

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
  /** [173] Modelldarstellung des Ausschnitts (`ViewSnapshot.modelViewOptionId`): geht der Ebene und der
   * Vorlage vor (Kern: `sheet_viewports::viewport_args`, Schnitt/Ansicht über `modelView`). */
  modelViewOptionId?: string | null,
  /** [272] Variantenkombination des Ausschnitts/Viewports (über der der Ebene; Kern: `sheet_viewports::snapshot_project`). */
  designOptions?: Record<string, string> | null,
): Promise<Plan> {
  const opts = designOptions && Object.keys(designOptions).length ? designOptions : null;
  if (!template && !modelViewOptionId && !opts) return levelPlan(project, levelId, visibleCodes, detail, scaleDenominator, forPrint, mono, overrideRuleIds);
  let tp = template ? projectWithTemplate(project, levelId, template) : project;
  if (modelViewOptionId) tp = projectWithModelView(tp, levelId, modelViewOptionId);
  if (opts) tp = projectWithDesignOptions(tp, levelId, opts);
  return withDocument(tp, () => levelPlan(tp, levelId, visibleCodes, template?.detail ?? detail, scaleDenominator, forPrint, mono, overrideRuleIds));
}

/**
 * Inhalt eines Ausschnitts auf dem Blatt bzw. im PDF: [266] 3D-Ausschnitte (Ansichtstyp „perspektive“) als 3D-Dokument aus dem
 * Kern (Vektor-Axonometrie/-Perspektive mit verdeckten Kanten, Kern: `sheet_viewports::doc3d_buf`), sonst {@link viewportLevelPlan}.
 */
export async function viewportSnapshotPlan(project: Project, snap: ViewSnapshot, visibleCodes: Set<string>, scaleDenominator: number, forPrint = false, viewport?: { designOptions?: Record<string, string> | null; designOptionCombination?: string | null } | null): Promise<Plan> {
  // [272] Variantenkombination: Ausschnitt, darüber die des Viewports (dieselbe Ansicht in anderer Kombination).
  const opts = viewportDesignOptions(project, snap, viewport);
  if (isDoc3dSnapshot(snap)) return snapshotAxoPlan(project, snap, visibleCodes, scaleDenominator, snapshotMono(project, snap), opts) ?? EMPTY;
  if (opts) {
    const dp = projectWithDesignOptions(project, snap.activeLevelId, opts);
    const fp = snap.renovationFilter ? projectWithRenovation(dp, snap.activeLevelId, snap.renovationFilter, snap.renovationPhase) : dp;
    return withDocument(fp, () => viewportLevelPlan(fp, snap.activeLevelId, visibleCodes, snap.detail, scaleDenominator, forPrint, snapshotMono(fp, snap), snapshotOverrideRuleIds(fp, snap), snapshotTemplate(fp, snap), snap.modelViewOptionId));
  }
  // [271] Umbaufilter des Ausschnitts: geht dem der Ebene vor (wie im Kern `sheet_viewports::viewport_args`).
  if (snap.renovationFilter) {
    const rp = projectWithRenovation(project, snap.activeLevelId, snap.renovationFilter, snap.renovationPhase);
    return withDocument(rp, () => viewportLevelPlan(rp, snap.activeLevelId, visibleCodes, snap.detail, scaleDenominator, forPrint, snapshotMono(rp, snap), snapshotOverrideRuleIds(rp, snap), snapshotTemplate(rp, snap), snap.modelViewOptionId));
  }
  return viewportLevelPlan(project, snap.activeLevelId, visibleCodes, snap.detail, scaleDenominator, forPrint, snapshotMono(project, snap), snapshotOverrideRuleIds(project, snap), snapshotTemplate(project, snap), snap.modelViewOptionId);
}

/** [272] Wahl eines Ausschnitts samt Viewport (Viewport geht vor; benannte Kombination vor freier Wahl, Kern `design_options::stored_choice`); `null` ohne eigene Wahl. */
export function viewportDesignOptions(
  project: Project,
  snap: { designOptions?: Record<string, string> | null; designOptionCombination?: string | null },
  viewport?: { designOptions?: Record<string, string> | null; designOptionCombination?: string | null } | null,
): Record<string, string> | null {
  const m = { ...(storedChoice(project, snap) ?? {}), ...(storedChoice(project, viewport) ?? {}) };
  return Object.keys(m).length ? m : null;
}

/** [272] Das Projekt mit der Variantenkombination `opts` an der Ebene `levelId` (über deren eigener Wahl). */
export function projectWithDesignOptions(project: Project, levelId: string, opts: Record<string, string>): Project {
  return {
    ...project,
    drawingLevels: project.drawingLevels.map((l) => {
      if (l.id !== levelId) return l;
      const next = { ...l, designOptions: { ...(storedChoice(project, l) ?? {}), ...opts } };
      delete next.designOptionCombination;
      return next;
    }),
  };
}

/** [271] Das Projekt mit Umbaufilter `filter` (und Etappe) an der Ebene `levelId`. */
export function projectWithRenovation(project: Project, levelId: string, filter: string, phase?: string): Project {
  return { ...project, drawingLevels: project.drawingLevels.map((l) => (l.id === levelId ? { ...l, renovationFilter: filter, ...(phase ? { renovationPhase: phase } : {}) } : l)) };
}

/** [173] Das Projekt mit der Modelldarstellung `id` an der Ebene `levelId` (wie die Vorlage ein Ebenen-Feld). */
export function projectWithModelView(project: Project, levelId: string, id: string): Project {
  return { ...project, drawingLevels: project.drawingLevels.map((l) => (l.id === levelId ? { ...l, modelViewOptionId: id } : l)) };
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
  const marks = levelMarksEnabled(level, project, (c) => visibleCodes.has(c)) ? levelMarkerPrimitives(project, raw.bounds, raw.primitives, scaleDenominator) : [];
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
