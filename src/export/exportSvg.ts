// SVG-Export des Grundrisses — Nutzer-Wunsch: „Kein SVG-Export. Nur DXF- und
// Vektor-PDF-Dialog existieren, obwohl `sceneToPrintSvg` intern längst
// druckgenaues SVG baut (für den PDF-Pfad) — wird nie als eigenständiger
// Download angeboten." Reine Serialisierung DESSELBEN Druck-SVG, das
// `exportPdf.ts` ohnehin schon baut (identische Quelle wie Bildschirm/PDF,
// s. dortiger Kopfkommentar) — nur ohne den Umweg über jsPDF/svg2pdf.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Plan } from "../plan/generatePlan";
import { planToRenderScene } from "../plan/toRenderScene";
import { sceneToPrintSvg } from "./sceneToPrintSvg";
import { pageSizeMm } from "./exportPdf";
import type { Orientation, PaperFormat } from "./exportPdf";

export interface ExportSvgOptions {
  /** Massstab-Nenner N (1:N) — dieselbe Bedeutung wie beim PDF-Export. */
  scaleDenominator: number;
  paper: PaperFormat;
  orientation: Orientation;
  /** Dateiname des Downloads (ohne/inkl. .svg). */
  fileName?: string;
}

/**
 * Baut das papier-mm-bemasste Druck-SVG als String (fertig zum Speichern/
 * Einbetten). Reine Funktion, kein Download — s. {@link savePlanSvg}.
 */
export function buildPlanSvg(plan: Plan, opts: ExportSvgOptions): string {
  const { w: pageW, h: pageH } = pageSizeMm(opts.paper, opts.orientation);
  const scene = planToRenderScene(plan, opts.scaleDenominator);
  const print = sceneToPrintSvg(scene, {
    scaleDenominator: opts.scaleDenominator,
    pageWidthMm: pageW,
    pageHeightMm: pageH,
    marginMm: 10,
  });
  return new XMLSerializer().serializeToString(print.svg);
}

/** Baut das SVG und löst den Download aus (Browser-Blob, wie `savePlanDxf`). */
export function savePlanSvg(plan: Plan, opts: ExportSvgOptions): void {
  const text = buildPlanSvg(plan, opts);
  const name = (opts.fileName ?? "grundriss").replace(/\.svg$/i, "");
  const blob = new Blob([text], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
