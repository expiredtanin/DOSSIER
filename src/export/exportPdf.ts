// Vektor-PDF-Export des Grundrisses. Baut aus einem Plan zunaechst DIESELBE
// render2d-Szene wie der Viewport (`planToRenderScene`, siehe
// `useWasmPlanRenderer.ts`/`nativeSync.ts` — identischer Aufruf, keine
// Sonderoptionen), serialisiert sie massstaeblich als Papier-SVG
// (`sceneToPrintSvg`) und rendert dieses per jsPDF + svg2pdf.js als ECHTES
// Vektor-PDF (Pfad-/Text-Operatoren, KEINE Rasterung). Bildschirm und PDF
// haben damit dieselbe Quelle, nur ein anderes Ziel (GPU-Framebuffer vs.
// Papier-mm-SVG). Papierformat (A4/A3) + Ausrichtung (Hoch/Quer) wählbar; der
// Plan wird zentriert aufs Blatt gesetzt, ein schlichtes Schriftfeld (Titel/
// Massstab) optional unten rechts.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { jsPDF } from "jspdf";
import "svg2pdf.js";
import type { Plan } from "../plan/generatePlan";
import { planToRenderScene } from "../plan/toRenderScene";
import { sceneToPrintSvg } from "./sceneToPrintSvg";

/** Unterstützte Papierformate (Blattmasse in mm, Hochformat-Basis). */
export type PaperFormat = "a4" | "a3";

/** Ausrichtung des Blatts. */
export type Orientation = "portrait" | "landscape";

/** Blattmasse je Format im Hochformat (mm). */
const PAGE_MM: Record<PaperFormat, { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
};

export interface ExportPdfOptions {
  /** Massstab-Nenner N (1:N). */
  scaleDenominator: number;
  paper: PaperFormat;
  orientation: Orientation;
  /** Plantitel/Geschossname fürs Schriftfeld. */
  title: string;
  /** Optionaler Untertitel (z. B. Projektname). */
  subtitle?: string;
  /** Schriftfeld zeichnen (Titel/Massstab). Default true. */
  titleBlock?: boolean;
  /** Dateiname des Downloads (ohne/inkl. .pdf). */
  fileName?: string;
}

/** Blattmasse (mm) nach Format + Ausrichtung. */
export function pageSizeMm(
  paper: PaperFormat,
  orientation: Orientation,
): { w: number; h: number } {
  const base = PAGE_MM[paper];
  return orientation === "landscape" ? { w: base.h, h: base.w } : base;
}

/**
 * Erzeugt das Vektor-PDF des Plans und liefert das jsPDF-Dokument zurück (der
 * Aufrufer speichert via {@link savePlanPdf} oder nutzt `doc.output(...)` zum
 * Testen). Das Schriftfeld nutzt die eingebaute Helvetica (Vektor-Text).
 */
export async function buildPlanPdf(
  plan: Plan,
  opts: ExportPdfOptions,
): Promise<jsPDF> {
  const { w: pageW, h: pageH } = pageSizeMm(opts.paper, opts.orientation);

  // Render-Szene wie der Viewport erzeugen, dann als Papier-SVG serialisieren.
  // Einziger Unterschied zum Viewport-Aufruf: der echte Export-Massstab wird an
  // `planToRenderScene` durchgereicht (derselbe `scaleDenominator` wie unten an
  // `sceneToPrintSvg`), damit der Zeilenabstand mehrzeiliger Stempeltexte auch
  // bei Nicht-1:100-Massstab papier-mm-genau stimmt. Etwas mehr unterer Rand,
  // falls ein Schriftfeld gezeichnet wird (damit es nicht in den Plan ragt).
  const margin = 10;
  const scene = planToRenderScene(plan, opts.scaleDenominator);
  const print = sceneToPrintSvg(scene, {
    scaleDenominator: opts.scaleDenominator,
    pageWidthMm: pageW,
    pageHeightMm: pageH,
    marginMm: margin,
  });

  const doc = new jsPDF({
    unit: "mm",
    format: [pageW, pageH],
    orientation: opts.orientation,
    compress: true,
  });

  // SVG → PDF (Vektor). Die viewBox des SVG ist in mm (Papier-Benutzereinheiten)
  // und deckungsgleich mit der Blattgröße; svg2pdf bildet sie 1:1 auf das mm-Ziel
  // (Blattbreite/-höhe) ab.
  await doc.svg(print.svg, { x: 0, y: 0, width: pageW, height: pageH });

  if (opts.titleBlock ?? true) {
    drawTitleBlock(doc, pageW, pageH, opts);
  }

  return doc;
}

/** Schlichtes Schriftfeld unten rechts: Titel, Untertitel, Massstab. */
function drawTitleBlock(
  doc: jsPDF,
  pageW: number,
  pageH: number,
  opts: ExportPdfOptions,
): void {
  const boxW = 70;
  const boxH = 22;
  const pad = 6;
  const x = pageW - boxW - pad;
  const y = pageH - boxH - pad;

  doc.setDrawColor(17, 17, 17);
  doc.setLineWidth(0.25);
  doc.rect(x, y, boxW, boxH);
  // Trennlinie zwischen Titel-Block und Massstab-Zeile.
  doc.line(x, y + boxH - 7, x + boxW, y + boxH - 7);

  doc.setTextColor(17, 17, 17);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(clip(opts.title, 30), x + 3, y + 6);

  if (opts.subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text(clip(opts.subtitle, 40), x + 3, y + 11);
  }

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`1:${opts.scaleDenominator}`, x + 3, y + boxH - 2.2);
  const fmt = `${opts.paper.toUpperCase()} ${
    opts.orientation === "landscape" ? "quer" : "hoch"
  }`;
  doc.text(fmt, x + boxW - 3, y + boxH - 2.2, { align: "right" });
}

/** Kürzt einen String auf maximal `max` Zeichen (mit Auslassung). */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Baut das PDF und löst den Download aus (Browser). */
export async function savePlanPdf(
  plan: Plan,
  opts: ExportPdfOptions,
): Promise<void> {
  const doc = await buildPlanPdf(plan, opts);
  const name = (opts.fileName ?? "grundriss").replace(/\.pdf$/i, "");
  doc.save(`${name}.pdf`);
}
