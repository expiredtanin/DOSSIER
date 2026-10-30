// Strichmuster des SVG-Plan-Pfads in viewBox-Einheiten (Modell-Raum) — wie die Engines: Linientypen in
// Papier-mm im PLOT-Massstab (render2d `ortho::dash_scale`), Schraffur-Striche gekoppelt an die
// Musterskala (Kern `hatch::hatch_dash` × `DASH_MM_TO_M`). So bleibt der Rhythmus beim Zoomen fest und
// gleicht der Druckansicht.

import { PX_PER_M } from "./geometry";
import { DASH_MM_TO_M } from "../glPlan/glPlanHatch";

/** CSS-Variable am Plan-SVG: CSS-px je viewBox-Einheit (meet), für Muster unter `non-scaling-stroke`. */
export const PLAN_DASH_VAR = "--plan-dash-k";

const clean = (v: number): number => (Number.isFinite(v) ? Math.max(0, v) : 0);

/** Linienmuster (Papier-mm) → viewBox-Einheiten im Plot-Massstab 1:`plotN` (ohne gültiges N: 1:100). */
export function lineDashVb(dash: readonly number[], plotN: number): number[] {
  const n = Number.isFinite(plotN) && plotN > 0 ? plotN : 100;
  return dash.map((mm) => ((clean(mm) * n) / 1000) * PX_PER_M);
}

/** Schraffur-Strichmuster (Papier-mm des Linienstils) → viewBox-Einheiten im Musterraum. */
export function hatchDashVb(dash: readonly number[], scale: number, random = false): number[] {
  const k = !random && Number.isFinite(scale) && scale > 0 ? scale : 1;
  return dash.map((mm) => clean(mm) * k * DASH_MM_TO_M * PX_PER_M);
}

/**
 * Muster so strecken, dass eine ganze Zahl Perioden in `period` passt (SVG-`<pattern>`-Kachel: das
 * Muster beginnt in jeder Kachel neu). Leeres/entartetes Muster bleibt unverändert.
 */
export function fitDashToPeriod(vb: readonly number[], period: number): number[] {
  const cycle = (vb.length % 2 ? 2 : 1) * vb.reduce((s, v) => s + v, 0);
  if (!(cycle > 1e-9) || !(period > 1e-9)) return [...vb];
  const k = Math.max(1, Math.round(period / cycle));
  const f = period / (k * cycle);
  return vb.map((v) => v * f);
}

/**
 * `stroke-dasharray` als CSS-Wert. Unter `non-scaling-stroke` gilt das Muster in Bildschirm-px — dann
 * über die meet-Variable am SVG zurück in den Modell-Raum (`calc(var(--plan-dash-k) * Xpx)`).
 */
export function dashArrayCss(vb: readonly number[], nonScaling: boolean): string | undefined {
  if (!vb.length) return undefined;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return vb.map((v) => (nonScaling ? `calc(var(${PLAN_DASH_VAR}, 1) * ${r(v)}px)` : `${r(v)}`)).join(" ");
}
