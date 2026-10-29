// Ausrichten und Verteilen der 2D-Auswahl — Fassade über den Kern ([K4] S3,
// `src-tauri/core/src/cmd_transform.rs::align_ops`/`distribute_ops`).
//
// Beides arbeitet auf den BOUNDING-BOXEN der Elemente (dieselbe Herleitung wie
// im Attribut-Panel: Kern `selection_info.rs::geom_bbox`) und verschiebt sie anschliessend als
// Ganzes. Die Form selbst bleibt unangetastet — es wird nur verschoben, nie
// skaliert oder verzerrt.

import type { Project } from "../model/types";
import { documentFor } from "../core/document";
import type { CoreOp } from "../core";

/** Ausrichtungskante bzw. -achse. */
export type AlignMode = "left" | "right" | "centerX" | "top" | "bottom" | "centerY";

/** Verteilungsachse: gleiche Abstände der Mittelpunkte entlang X bzw. Y. */
export type DistributeAxis = "x" | "y";

/**
 * Richtet die Elemente an der gemeinsamen Kante bzw. Mittelachse aus. Bezug
 * ist die Hülle ALLER gewählten Elemente (wie in Grafikprogrammen üblich):
 * „linksbündig" schiebt alle an den linkesten Rand der Auswahl.
 *
 * Weniger als zwei Elemente ergeben keine Ausrichtung (nichts, woran man sich
 * ausrichten könnte) — das Projekt bleibt unverändert.
 */
export function alignOps(project: Project, ids: string[], mode: AlignMode): CoreOp[] {
  return documentFor(project).cmdOps({ cmd: "align", ids, mode });
}

/**
 * Verteilt die Elemente mit GLEICHEN MITTENABSTÄNDEN entlang der Achse. Die
 * beiden äussersten bleiben stehen und spannen den Bereich auf — alles
 * dazwischen rückt auf gleichmässige Abstände.
 *
 * Unter drei Elementen gibt es nichts zu verteilen (die Äusseren bleiben ja
 * ohnehin stehen) — das Projekt bleibt unverändert.
 */
export function distributeOps(project: Project, ids: string[], axis: DistributeAxis): CoreOp[] {
  return documentFor(project).cmdOps({ cmd: "distribute", ids, axis });
}
