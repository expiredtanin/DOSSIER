// Ansicht aus dem Kern ([K3c]): die Abfrage `elevationPlan` (`src-tauri/core/src/plan/elevation.rs`)
// projiziert Wände, Decken, Dächer und Öffnungen in die Ansichtsebene, verdeckt, schattiert und sortiert
// fern → nah (Painter) und liefert den Plan-Puffer v2 samt Pick-Ids. Einheiten: Meter; u entlang der
// Ebene (Blickrichtungs-RECHTS), v = absolute Höhe.

import type { DrawingLevel, Project } from "../model/types";
import { documentFor } from "../core/document";
import { decodePlanBuf } from "./planBuf";
import { lazyPlan } from "./planLazy";
import { hasLine, levelArg, visibilityArgs } from "./toSection";
import type { CategoryDisplayResolver, Plan } from "./generatePlan";

/** Optionen des Ansichts-Generators. */
export interface ElevationOptions {
  /** Schlagschatten zeichnen (Default aus `level.shadows`). */
  shadows?: boolean;
  /** Schwarz-Weiss-Modus (neutralisierte Füllungen). */
  mono?: boolean;
  /**
   * Ebenen-Panel-Sichtbarkeit: mit beiden Angaben werden Flächen ausgeblendeter Kategorien vor der
   * Verdeckung entfernt (sie verdecken dann auch nichts); ohne bleibt jede Fläche sichtbar.
   */
  visibleCodes?: Set<string>;
  categoryDisplay?: CategoryDisplayResolver;
}

/**
 * Ansichts-Plan einer Ebene (gefüllte Fassadenansicht, Painter fern → nah, Öffnungen, Schatten,
 * Bodenlinie). `null` ohne Ansichtslinie.
 */
export function generateElevationPlan(project: Project, level: DrawingLevel, opts: ElevationOptions = {}): Plan | null {
  if (!hasLine(level)) return null;
  const shadows = opts.shadows ?? level.shadows ?? false;
  const text = JSON.stringify({ level: levelArg(level), ...visibilityArgs(project, opts.visibleCodes, opts.categoryDisplay) });
  const buf = decodePlanBuf(documentFor(project).queryBin("elevationPlan", [opts.mono ? 1 : 0, shadows ? 1 : 0], text));
  if (buf.groups.length === 0) return null;
  const b = buf.bounds ?? [0, 0, 1, 1];
  return lazyPlan(
    { bounds: { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] } },
    buf.groups.map(([from, to]) => ({ buf, from, to })),
  );
}
