// Automatische Höhenkoten im Schnitt/in der Ansicht: je Geschoss die Kote
// OK fertig Boden (`baseElevation`, ±0.00 = Bezug) plus die oberste Kante des
// Gebäudes (First/OK Dach), links neben der Zeichnung mit einer kurzen
// Bezugslinie zur Geometrie. Symbol = dieselbe SIA-400-Kote wie das 2D-Element
// `kote`; gerechnet im Kern (`plan/drawings.rs::level_markers`, Abfrage `levelMarkers`).
// Abschaltbar je Ebene (`DrawingLevel.levelMarks`), über die Modelldarstellung ([173]) oder die Klasse
// „Höhenkoten" ([180]).

import type { DrawingLevel, Project } from "../model/types";
import type { Plan, Primitive } from "./generatePlan";
import { documentFor } from "../core/document";
import { decodePlanBuf } from "./planBuf";
import { derivedVisible, LEVEL_MARK_CATEGORY } from "../model/derivedCategories";

/**
 * Ob eine Ebene automatische Koten trägt: Ebene > [173] Modelldarstellung der Ebene (`dimensions.levelMarks`,
 * Rangfolge wie Kern `model_view::Options::level_marks`) > an.
 */
export function levelMarksEnabled(
  level: DrawingLevel,
  project?: Pick<Project, "modelViewOptions"> & Partial<Pick<Project, "layers">>,
  shown?: (code: string) => boolean,
): boolean {
  const mv = level.modelViewOptionId ? project?.modelViewOptions?.find((m) => m.id === level.modelViewOptionId) : undefined;
  const on = level.levelMarks ?? mv?.dimensions?.levelMarks ?? true;
  // [180] Die Koten liegen auf der Klasse „Höhenkoten": ausgeblendet ⇒ ohne (`shown`: sichtbar und gezeichnet).
  return on && (!shown || !project?.layers || derivedVisible(project.layers, LEVEL_MARK_CATEGORY, shown));
}

/**
 * Kote-Primitive für den Roh-Plan `plan` eines Schnitts/einer Ansicht (`generateSectionPlan`/`generateElevationPlan`).
 * Lage (links neben dem Gebauten, Nachbarn und Gelände zählen nicht) und Höhen rechnet allein der Kern ([256]:
 * keine TS-Doppelspur mehr); Höhen ausserhalb der Zeichnung entfallen. [208] `scaleDenominator`: Koten in Papiergrösse
 * (2 mm Schrift; Standard 1:100). Ohne Quell-Abfrage am Plan (leer, fremder Plan): keine Koten.
 */
export function levelMarkerPrimitives(project: Project, plan: Pick<Plan, "marksSource">, scaleDenominator = 100): Primitive[] {
  const src = plan.marksSource;
  if (!src) return [];
  return decodePlanBuf(documentFor(project).queryBin("levelMarkersOf", [scaleDenominator], JSON.stringify({ name: src.name, args: Array.from(src.args), text: src.text }))).prims;
}
