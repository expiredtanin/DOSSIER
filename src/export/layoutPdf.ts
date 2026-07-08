// Ordner → Mehrseiten-PDF (DOSSIER A3): exportiert alle Layouts eines Ordners
// als EIN gemeinsames PDF, jedes Layout = eine Seite. Das Rendering je Seite
// spiegelt exakt `ui/LayoutSheet.tsx` (Master-Rahmen + Titelblock + echte
// Viewport-Pläne via `generatePlan`→`planToPrintSvg`) und komponiert die Seiten
// per jsPDF (`addPage` je Layout) analog `export/exportPdf.ts` (buildPlanPdf).
//
// Trennung: die Seiten-Sammlung/-Reihenfolge + effektive Blattgrösse ist reine,
// testbare Logik (`folderPdfPages`, layoutModel); das SVG/jsPDF-Rendering
// (`buildFolderPdf`) braucht ein DOM und läuft nur im Browser/Tauri.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { jsPDF } from "jspdf";
import "svg2pdf.js";
import type { MasterLayout, Project } from "../model/types";
import { generatePlan } from "../plan/generatePlan";
import { planToPrintSvg } from "./planToPrintSvg";
import { saveBinaryFile } from "../io/saveFile";
import {
  findMaster,
  findSnapshot,
  folderPdfPages,
  resolveTitleBlock,
  resolveViewportScale,
  visibleCodesFromSnapshot,
  type FolderPdfPage,
  type ResolvedTitleBlock,
} from "../panels/layoutModel";

export { folderPdfPages, type FolderPdfPage };

/** Titelblock (mm-Vektor) auf die aktuelle jsPDF-Seite — Anmutung wie LayoutSheet. */
function drawTitleBlock(
  doc: jsPDF,
  sheetW: number,
  sheetH: number,
  tb: ResolvedTitleBlock,
  paper: string,
  orientation: string,
): void {
  const boxW = 70;
  const boxH = 30;
  const pad = 6;
  const x = sheetW - boxW - pad;
  const y = sheetH - boxH - pad;
  const fmt = `${paper.toUpperCase()} ${orientation === "landscape" ? "quer" : "hoch"}`;

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(17, 17, 17);
  doc.setLineWidth(0.35);
  doc.rect(x, y, boxW, boxH, "FD");
  doc.setLineWidth(0.2);
  doc.line(x, y + 8, x + boxW, y + 8);
  doc.line(x, y + boxH - 7, x + boxW, y + boxH - 7);

  doc.setTextColor(17, 17, 17);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(clip(tb.projectName, 34), x + 3, y + 5.6);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(clip(tb.sheetName, 36), x + 3, y + 13);
  if (tb.author) {
    doc.setFontSize(7);
    doc.setTextColor(68, 68, 68);
    doc.text(clip(tb.author, 40), x + 3, y + 18);
    doc.setTextColor(17, 17, 17);
  }
  doc.setFontSize(8);
  doc.text(tb.scale, x + 3, y + boxH - 2.4);
  doc.setFontSize(7);
  doc.text(`${tb.date} · ${fmt}`, x + boxW - 3, y + boxH - 2.4, { align: "right" });
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Zeichnet die Viewports + Master-Elemente EINER Seite in das jsPDF-Dokument. */
async function renderPage(
  doc: jsPDF,
  project: Project,
  page: FolderPdfPage,
  master: MasterLayout | undefined,
): Promise<void> {
  const { layout, widthMm, heightMm } = page;

  // Echte Viewport-Pläne (wie ViewportPlan in LayoutSheet.tsx).
  for (const vp of layout.viewports) {
    const snap = findSnapshot(project, vp.snapshotId);
    if (!snap) continue;
    try {
      const codes = visibleCodesFromSnapshot(snap);
      const plan = generatePlan(
        project,
        snap.activeLevelId,
        codes,
        undefined,
        snap.detail,
        false,
        false,
      );
      const scaleN = resolveViewportScale(vp, snap);
      const print = planToPrintSvg(plan, {
        scaleDenominator: scaleN,
        pageWidthMm: vp.widthMm,
        pageHeightMm: vp.heightMm,
      });
      await doc.svg(print.svg, {
        x: vp.xMm,
        y: vp.yMm,
        width: vp.widthMm,
        height: vp.heightMm,
      });
    } catch {
      // Einzelner Viewport, der nicht rendert, darf die Seite nicht killen.
    }
  }

  // Master: Rahmen + Titelblock (read-only, wie im In-Viewport-Editor).
  if (master) {
    if (master.border ?? true) {
      doc.setDrawColor(17, 17, 17);
      doc.setLineWidth(0.35);
      doc.rect(5, 5, widthMm - 10, heightMm - 10);
    }
    const tb = resolveTitleBlock(project, layout, master);
    drawTitleBlock(doc, widthMm, heightMm, tb, layout.paper, layout.orientation);
  }
}

/**
 * Baut das Mehrseiten-PDF eines Ordners und liefert das jsPDF-Dokument. Jede
 * Seite = ein Layout in Baum-Reihenfolge. Gibt `null`, wenn der Ordner keine
 * Layouts enthält (der Aufrufer meldet das dann in der UI).
 */
export async function buildFolderPdf(
  project: Project,
  folderId: string,
): Promise<jsPDF | null> {
  const pages = folderPdfPages(project, folderId);
  if (pages.length === 0) return null;

  const orientOf = (p: FolderPdfPage) =>
    p.widthMm > p.heightMm ? "landscape" : "portrait";

  const first = pages[0];
  const doc = new jsPDF({
    unit: "mm",
    format: [first.widthMm, first.heightMm],
    orientation: orientOf(first),
    compress: true,
  });

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (i > 0) doc.addPage([page.widthMm, page.heightMm], orientOf(page));
    const master = findMaster(project, page.layout);
    await renderPage(doc, project, page, master);
  }

  return doc;
}

/**
 * Baut das Ordner-PDF und speichert es (nativer Tauri-Dialog bzw.
 * Browser-Download). Liefert `false`, wenn nichts zu exportieren war oder der
 * Speichern-Dialog abgebrochen wurde.
 */
export async function saveFolderPdf(
  project: Project,
  folderId: string,
  fileName: string,
): Promise<boolean> {
  const doc = await buildFolderPdf(project, folderId);
  if (!doc) return false;
  const bytes = doc.output("arraybuffer");
  const name = fileName.replace(/\.pdf$/i, "");
  return saveBinaryFile(new Uint8Array(bytes), `${name}.pdf`, "application/pdf");
}
