// Plan → SVG-TEXT ohne DOM (für `dossier-cli` und Referenzbild-Tests, lessons-bimcraft [4]/[17]).
// Der Druck-Export (`sceneToPrintSvg`) baut ein DOM-Element für svg2pdf; dieser Serializer ist
// die schlanke, headless Variante: Koordinaten in Metern (Y nach oben → SVG gespiegelt),
// Strichstärken aus Papier-mm über den Massstab umgerechnet. Schraffur-Muster werden nicht
// ausgebreitet (nur Grundfüllung), Bilder fehlen — gedacht für Kontrolle und Diffs, nicht für Druck.
// Geschrieben vom Kern direkt aus dem Plan-Puffer ([K3d], `src-tauri/core/src/plan_svg.rs`).

import type { Plan } from "../plan/generatePlan";
import { planParts, withPlanParts } from "../plan/planParts";
import { core } from "../engine/coreWasm";

export interface SvgStringOptions {
  /** Massstab-Nenner N (1:N) — bestimmt die Umrechnung Papier-mm → Meter. Default 100. */
  scaleDenominator?: number;
  /** Rand um den Planinhalt in Metern. Default 0.5. */
  marginM?: number;
}

export function planToSvgString(plan: Plan, opts: SvgStringOptions = {}): string {
  const b = plan.bounds;
  const o = Float64Array.from([opts.scaleDenominator ?? 100, opts.marginM ?? 0.5, b.minX, b.minY, b.maxX, b.maxY]);
  return withPlanParts(planParts(plan, true), (segs) => core().plan_svg_string(segs, o));
}
