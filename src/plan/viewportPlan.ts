// [115] Inhalt eines Layout-Viewports: der Plan der Ebene, auf die sein Ausschnitt zeigt — Geschoss und
// Zeichnung wie bisher über `generatePlan`, Schnitt und Ansicht wie in der Schnitt-/Ansichts-Ansicht
// (`SectionPlanView`): abgeleitete Projektion aus dem Kern, automatische Koten und die eigenen
// 2D-Elemente der Ebene. Vorher rechneten Viewports nur Grundrisse — ein Schnitt-Ausschnitt auf dem
// Blatt zeigte bloss seine 2D-Elemente. Nur Zusammensetzen vorhandener Kern-Abfragen.

import type { DetailLevel } from "../model/viewTypes";
import type { Project } from "../model/types";
import { generatePlan, type Plan, type Primitive } from "./generatePlan";
import { computeSection, generateSectionPlan } from "./toSection";
import { generateElevationPlan } from "./toElevation";
import { levelMarkerPrimitives, levelMarksEnabled } from "./levelMarkers";

const EMPTY: Plan = { primitives: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };

/**
 * Plan der Ebene `levelId` für einen Layout-Viewport bzw. dessen PDF (`forPrint`: `noPrint`-Elemente
 * entfallen). Schnitte brauchen die truck-Körper und sind darum asynchron.
 */
export async function viewportLevelPlan(
  project: Project,
  levelId: string,
  visibleCodes: Set<string>,
  detail: DetailLevel | undefined,
  scaleDenominator: number,
  forPrint = false,
): Promise<Plan> {
  const level = project.drawingLevels.find((l) => l.id === levelId);
  if (!level) return EMPTY;
  if (level.kind !== "section" && level.kind !== "elevation") {
    return generatePlan(project, levelId, visibleCodes, undefined, detail, false, false, true, scaleDenominator, forPrint);
  }
  let raw: Plan | null;
  if (level.kind === "section") {
    const out = await computeSection(project, level);
    raw = out
      ? generateSectionPlan(out, false, { hiddenLines: level.hiddenLines, visibleCodes, openings: true, scaleDenominator })
      : null;
  } else {
    raw = generateElevationPlan(project, level, { visibleCodes, scaleDenominator });
  }
  if (!raw || raw.primitives.length === 0) return EMPTY;
  const own = generatePlan(project, level.id, visibleCodes, undefined, detail, false, false, false, scaleDenominator, forPrint);
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
