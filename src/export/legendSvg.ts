// Legende → Plan/Druck-SVG ([82]). Die Legende-Elemente (`analysis/legend.ts`) liegen auf einer Blatt-Ebene
// eines Hilfsprojekts ohne Bauteile; `generatePlan` (Kern: Schraffur-Muster, Linientypen, Schrift) und
// `planToPrintSvg` erzeugen daraus genau das, was auch eine Blatt-Zeichnung ergäbe — Bildschirm und PDF
// teilen diesen Weg.

import type { Layout, LayoutLegend, Project } from "../model/types";
import { collectVisibleCodes } from "../model/types";
import { generatePlan, type Plan } from "../plan/generatePlan";
import { legendDrawings, legendEntries } from "../analysis/legend";
import { SHEET_SCALE_DENOMINATOR, sheetMmToModel } from "../model/layoutModel";
import { planToPrintSvg } from "./planToPrintSvg";

export interface LegendPlan {
  plan: Plan;
  /** Linke obere Ecke und Grösse der Legende auf dem Blatt (mm). */
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

/** Hilfsprojekt: nur Stile/Kategorien des Projekts + die Legende-Elemente auf einer Blatt-Ebene. */
function legendProject(project: Project, layout: Layout, drawings: ReturnType<typeof legendDrawings>["drawings"], levelId: string): Project {
  return {
    ...project,
    walls: [],
    ceilings: [],
    roofs: [],
    openings: [],
    stairs: [],
    rooms: [],
    columns: [],
    groups: [],
    extrudedSolids: [],
    context: [],
    parametricWalls: [],
    drawings2d: drawings,
    drawingLevels: [{ id: levelId, name: layout.name, kind: "drawing", visible: true, locked: false, layoutId: layout.id }],
  };
}

/** Plan der Legende (`null`, wenn es nichts aufzulisten gibt und die Legende automatisch ist). */
export function legendPlan(project: Project, layout: Layout, legend: LayoutLegend): LegendPlan | null {
  const entries = legendEntries(project, layout, legend);
  const levelId = `legend-${legend.id}`;
  const { drawings, widthMm, heightMm } = legendDrawings(project, legend, entries, levelId);
  const tmp = legendProject(project, layout, drawings, levelId);
  const plan = generatePlan(tmp, levelId, collectVisibleCodes(tmp.layers), undefined, "fein", false, false, false, SHEET_SCALE_DENOMINATOR, true);
  return { plan, xMm: legend.xMm, yMm: legend.yMm, widthMm, heightMm };
}

/** Druck-SVG der Legende in einem eigenen Koordinatensystem (0..width, 0..height in mm), ohne weisses Blatt. */
export function legendPrintSvg(lp: LegendPlan): SVGSVGElement {
  const a = sheetMmToModel(lp.xMm, lp.yMm + lp.heightMm);
  const b = sheetMmToModel(lp.xMm + lp.widthMm, lp.yMm);
  return planToPrintSvg(lp.plan, {
    scaleDenominator: SHEET_SCALE_DENOMINATOR,
    pageWidthMm: lp.widthMm,
    pageHeightMm: lp.heightMm,
    bounds: { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y },
    transparent: true,
  }).svg;
}
