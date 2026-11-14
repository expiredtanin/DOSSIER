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
import type { Layout, LayoutPaperFormat, MasterLayout, Project } from "../model/types";
import { t } from "../i18n/translate";
import { legendPlan, legendPrintSvg } from "./legendSvg";
import { categoryLayerGroups, enablePdfLayers, type PdfLayers } from "./pdfLayers";
import { generatePlan, type Plan } from "../plan/generatePlan";
import { snapshotMono, snapshotOverrideRuleIds, snapshotTemplate, viewportLevelPlan } from "../plan/viewportPlan";
import { planToPrintSvg } from "./planToPrintSvg";
import { drawTablesPdf, sheetTables } from "./sheetTable";
import { applyPdfInfo, finishPdfBytes } from "./pdfInfo";
import { imageGeometry } from "../model/layoutImages";
import { posterHeaderItems, viewportScaleLabel } from "../model/posterTemplates";
import { collectVisibleCodes } from "../model/types";
import {
  effectiveSheetSizeMm,
  findMaster,
  sheetSizeMm,
  findSnapshot,
  folderPdfPages,
  resolveTitleBlock,
  resolveViewportScale,
  SHEET_SCALE_DENOMINATOR,
  sheetLevelOf,
  sheetMmToModel,
  visibleCodesFromSnapshot,
  type FolderPdfPage,
  type ResolvedTitleBlock,
} from "../model/layoutModel";

export { folderPdfPages, type FolderPdfPage };

/** Titelblock (mm-Vektor) auf die aktuelle jsPDF-Seite — Anmutung wie LayoutSheet. */
function drawTitleBlock(
  doc: jsPDF,
  sheetW: number,
  sheetH: number,
  tb: ResolvedTitleBlock,
  paper: string,
  orientation: string,
  showRevision: boolean,
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
  doc.text(clip(tb.projectName, 28), x + 3, y + 5.6);
  doc.text(tb.planNumber, x + boxW - 3, y + 5.6, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(clip(tb.sheetName, 36), x + 3, y + 13);
  if (showRevision && tb.revision) {
    doc.setFontSize(7);
    doc.text(`${t("layouts.revision.short")} ${tb.revision}`, x + boxW - 3, y + 13, { align: "right" });
    doc.setFontSize(8);
  }
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

/** Schrifthöhe in mm → pt (jsPDF misst Schriftgrössen in pt). */
const MM_TO_PT = 72 / 25.4;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Die 2D-Zeichnung des Blatts (Blatt-Ebene, `DrawingLevel.layoutId`) über Viewports und Master:
 * derselbe Plan wie am Bildschirm (`generatePlan`, Massstab 1:1, Export-Modus), über
 * `planToPrintSvg` fest aufs Papier gelegt (Ursprung oben links), ohne eigenes weisses Blatt.
 */
async function renderSheetDrawing(doc: jsPDF, project: Project, layout: Layout, widthMm: number, heightMm: number): Promise<void> {
  const level = sheetLevelOf(project, layout.id);
  if (!level || !project.drawings2d.some((d) => d.levelId === level.id)) return;
  const a = sheetMmToModel(0, heightMm);
  const b = sheetMmToModel(widthMm, 0);
  const plan = generatePlan(
    project,
    level.id,
    collectVisibleCodes(project.layers),
    undefined,
    "fein",
    false,
    false,
    false,
    SHEET_SCALE_DENOMINATOR,
    true,
  );
  const print = planToPrintSvg(plan, {
    scaleDenominator: SHEET_SCALE_DENOMINATOR,
    pageWidthMm: widthMm,
    pageHeightMm: heightMm,
    bounds: { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y },
    transparent: true,
  });
  await doc.svg(print.svg, { x: 0, y: 0, width: widthMm, height: heightMm });
}

/** Optionen des Seiten-Aufbaus (Publikationssätze, [79]/[80]). */
export interface PdfPagesOptions {
  /** PDF-Ebenen (Optional Content) je Kategorie, Rahmen/Titelblock, Blatt-Zeichnung und Legende. */
  layers?: boolean;
  /** Massstab (1:N) für alle Viewports. */
  scaleOverride?: number;
  /** Papierformat für alle Seiten: der Blatt-Inhalt wird einheitlich eingepasst und zentriert. */
  paperOverride?: LayoutPaperFormat;
  /** Revisionsindex im Titelblock (Standard ja). */
  includeRevision?: boolean;
}

interface PageCtx {
  layers?: PdfLayers;
  scaleOverride?: number;
  includeRevision: boolean;
}

/** `fn` in der PDF-Ebene `name` (ohne Ebenen: direkt). */
function inLayer(ctx: PageCtx, name: string, fn: () => void | Promise<void>): Promise<void> | void {
  return ctx.layers ? ctx.layers.run(name, fn) : fn();
}

/**
 * Bilder des Blatts ([208]): das Original unverändert eingebettet (JPEG ohne Neukompression), auf den Rahmen
 * geklippt; mit Zuschnitt liegt das ganze Bild verschoben/vergrössert dahinter, sichtbar ist nur der Rahmen.
 */
function drawImagesPdf(doc: jsPDF, layout: Layout): void {
  for (const img of layout.images ?? []) {
    const m = /^data:image\/(png|jpeg);base64,/.exec(img.src);
    if (!m || img.widthMm <= 0 || img.heightMm <= 0) continue;
    const g = imageGeometry(img);
    doc.saveGraphicsState();
    doc.rect(g.clip.x, g.clip.y, g.clip.w, g.clip.h, null);
    doc.clip();
    doc.discardPath();
    try {
      doc.addImage(img.src, m[1] === "png" ? "PNG" : "JPEG", g.draw.x, g.draw.y, g.draw.w, g.draw.h, img.id, "NONE");
    } finally {
      doc.restoreGraphicsState();
    }
  }
}

/** Massstabsangabe unter jedem Viewport ([208], Master `viewportScaleLabels`). */
function drawScaleLabelsPdf(doc: jsPDF, project: Project, layout: Layout, sheet: { w: number; h: number }, scaleOverride?: number): void {
  doc.setTextColor(17, 17, 17);
  doc.setFont("helvetica", "normal");
  for (const vp of layout.viewports) {
    const l = viewportScaleLabel(project, vp, sheet, scaleOverride);
    if (!l) continue;
    doc.setFontSize(l.sizeMm * MM_TO_PT);
    doc.text(l.text, l.x, l.y);
  }
}

/** Plakat-Kopfzeile ([208]): Band, Kennwort-Feld, Titel, „Plan x/n". */
function drawPosterHeaderPdf(doc: jsPDF, project: Project, layout: Layout, master: MasterLayout, sheet: { w: number; h: number }): void {
  doc.setDrawColor(17, 17, 17);
  doc.setTextColor(17, 17, 17);
  for (const it of posterHeaderItems(project, layout, master, sheet)) {
    if (it.kind === "rect") {
      doc.setLineWidth(it.stroke);
      doc.rect(it.x, it.y, it.w, it.h);
    } else {
      doc.setFont("helvetica", it.bold ? "bold" : "normal");
      doc.setFontSize(it.sizeMm * MM_TO_PT);
      doc.text(it.text, it.x, it.y, { align: it.align });
    }
  }
}

/** Zeichnet die Viewports + Master-Elemente EINER Seite in das jsPDF-Dokument. */
async function renderPage(
  doc: jsPDF,
  project: Project,
  page: FolderPdfPage,
  master: MasterLayout | undefined,
  ctx: PageCtx,
): Promise<void> {
  const { layout, widthMm, heightMm } = page;

  // Echte Viewport-Pläne (wie ViewportPlan in LayoutSheet.tsx).
  for (const vp of layout.viewports) {
    const snap = findSnapshot(project, vp.snapshotId);
    if (!snap) continue;
    try {
      const codes = visibleCodesFromSnapshot(snap);
      // Massstab zuerst: er geht in die Plan-Erzeugung ein (Bemassung in Papier-mm, Strichstärken
      // nach Massstab) — wie ViewportPlan in LayoutSheet.tsx, sonst wiche das PDF von der Vorschau ab.
      const scaleN = ctx.scaleOverride ?? resolveViewportScale(vp, snap);
      // Geschoss/Zeichnung, Schnitt oder Ansicht ([115]) — wie ViewportPlanSvg, im Druck-Modus.
      // [33] Override-Regeln des Ausschnitts bzw. seiner verknüpften Ansichtsvorlage (wie am Bildschirm).
      const ruleIds = snapshotOverrideRuleIds(project, snap);
      const template = snapshotTemplate(project, snap);
      const planOf = (visible: Set<string>) => viewportLevelPlan(project, snap.activeLevelId, visible, snap.detail, scaleN, true, snapshotMono(project, snap), ruleIds, template, snap.modelViewOptionId);
      const draw = async (plan: Plan, transparent: boolean, bounds?: Plan["bounds"]) => {
        const print = planToPrintSvg(plan, { scaleDenominator: scaleN, pageWidthMm: vp.widthMm, pageHeightMm: vp.heightMm, transparent, bounds });
        await doc.svg(print.svg, { x: vp.xMm, y: vp.yMm, width: vp.widthMm, height: vp.heightMm });
      };
      const full = await planOf(codes);
      if (!ctx.layers) {
        await draw(full, false);
      } else {
        // Weisser Grund bleibt ausserhalb der Ebenen; der Inhalt je Wurzel-Kategorie in eigener Ebene.
        // Alle Ebenen mit den Grenzen des GANZEN Plans, sonst läge jede anders zentriert.
        doc.setFillColor(255, 255, 255);
        doc.rect(vp.xMm, vp.yMm, vp.widthMm, vp.heightMm, "F");
        for (const g of categoryLayerGroups(project.layers, codes, t("pdfLayers.other"))) {
          const plan = await planOf(g.codes);
          if (plan.primitives.length === 0) continue; // leere Ebenen nicht anlegen
          await ctx.layers.run(g.name, () => draw(plan, true, full.bounds));
        }
      }
    } catch {
      // Einzelner Viewport, der nicht rendert, darf die Seite nicht killen.
    }
  }

  // Bilder ([208]): Renderings, Fotos — über den Viewports, unter Legenden und Schriftfeld.
  try {
    await inLayer(ctx, t("pdfLayers.images"), () => drawImagesPdf(doc, layout));
  } catch {
    // Ein Bild, das nicht einbettet, darf die Seite nicht killen.
  }

  // Massstab je Viewport ([208]).
  if (master?.viewportScaleLabels) {
    await inLayer(ctx, t("pdfLayers.frame"), () => drawScaleLabelsPdf(doc, project, layout, { w: widthMm, h: heightMm }, ctx.scaleOverride));
  }

  // Legenden ([82]): live aus den Viewports (oder Handauswahl), Muster vom Kern-Schraffurgenerator.
  for (const lg of layout.legends ?? []) {
    try {
      const lp = legendPlan(project, layout, lg);
      if (!lp) continue;
      await inLayer(ctx, t("pdfLayers.legend"), async () => {
        await doc.svg(legendPrintSvg(lp), { x: lp.xMm, y: lp.yMm, width: lp.widthMm, height: lp.heightMm });
      });
    } catch {
      // Eine Legende, die nicht rendert, darf die Seite nicht killen.
    }
  }

  // Master: Rahmen + Titelblock (read-only, wie im In-Viewport-Editor).
  if (master) {
    await inLayer(ctx, t("pdfLayers.frame"), () => {
      if (master.border ?? true) {
        doc.setDrawColor(17, 17, 17);
        doc.setLineWidth(0.35);
        doc.rect(5, 5, widthMm - 10, heightMm - 10);
      }
      // [208] Plakat-Vorlage: Kopfzeile statt Schriftfeld.
      if (!master.posterHeader) drawTitleBlock(doc, widthMm, heightMm, resolveTitleBlock(project, layout, master), layout.paper, layout.orientation, ctx.includeRevision);
      if (master.posterHeader) drawPosterHeaderPdf(doc, project, layout, master, { w: widthMm, h: heightMm });
    });
  }

  // Lebendige Tabellen ([111]): Vektortext + Linien wie in der Blattansicht.
  try {
    await inLayer(ctx, t("pdfLayers.tables"), () => drawTablesPdf(doc, sheetTables(project, layout.id)));
  } catch {
    // Eine Tabelle, die nicht rechnet, darf die Seite nicht killen.
  }

  // 2D-Zeichnung des Blatts — ÜBER Viewports + Master, wie am Bildschirm.
  try {
    await inLayer(ctx, t("pdfLayers.sheetDrawing"), () => renderSheetDrawing(doc, project, layout, widthMm, heightMm));
  } catch {
    // Eine Blatt-Zeichnung, die nicht rendert, darf die Seite nicht killen.
  }
}

/** Seiten für Layouts nach ids (Reihenfolge der ids; ein gebundener Master gibt die Blattgrösse vor). */
export function layoutPages(project: Project, layoutIds: readonly string[]): FolderPdfPage[] {
  const all = project.layouts ?? [];
  return layoutIds.flatMap((id) => {
    const layout = all.find((l) => l.id === id);
    if (!layout) return [];
    const { w, h } = effectiveSheetSizeMm(findMaster(project, layout) ?? layout);
    return [{ layout, widthMm: w, heightMm: h }];
  });
}

/**
 * Baut ein Mehrseiten-PDF aus Seiten (eine Seite je Layout) und liefert das jsPDF-Dokument; `null` ohne Seiten.
 * Optionen: PDF-Ebenen, Massstab-/Papier-Übersteuerung, Revisionsindex ([79]/[80]).
 */
export async function buildPagesPdf(project: Project, pages: FolderPdfPage[], opts: PdfPagesOptions = {}): Promise<jsPDF | null> {
  if (pages.length === 0) return null;
  const sizeOf = (p: FolderPdfPage) => (opts.paperOverride ? sheetSizeMm(opts.paperOverride, p.widthMm > p.heightMm ? "landscape" : "portrait") : { w: p.widthMm, h: p.heightMm });
  const orientOf = (s: { w: number; h: number }) => (s.w > s.h ? "landscape" : "portrait");

  const first = sizeOf(pages[0]);
  const doc = new jsPDF({ unit: "mm", format: [first.w, first.h], orientation: orientOf(first), compress: true });
  // Info-Wörterbuch: anonym nur das Kennwort ([208]); sonst Projektname und Bearbeiter des ersten Blatts.
  const firstMaster = findMaster(project, pages[0].layout);
  applyPdfInfo(doc, project, firstMaster ? resolveTitleBlock(project, pages[0].layout, firstMaster).author : undefined);
  const ctx: PageCtx = {
    layers: opts.layers ? enablePdfLayers(doc) : undefined,
    scaleOverride: opts.scaleOverride && opts.scaleOverride > 0 ? opts.scaleOverride : undefined,
    includeRevision: opts.includeRevision ?? true,
  };
  const internal = doc.internal as unknown as { write: (s: string) => void; scaleFactor: number };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const size = sizeOf(page);
    if (i > 0) doc.addPage([size.w, size.h], orientOf(size));
    // Papier-Übersteuerung: Inhalt einheitlich auf die neue Seite einpassen (oben-links-Ursprung, zentriert).
    const fit = size.w !== page.widthMm || size.h !== page.heightMm;
    if (fit) {
      const s = Math.min(size.w / page.widthMm, size.h / page.heightMm);
      const k = internal.scaleFactor;
      const tx = ((size.w - s * page.widthMm) / 2) * k;
      const ty = (1 - s) * size.h * k - ((size.h - s * page.heightMm) / 2) * k;
      internal.write(`q ${s} 0 0 ${s} ${tx} ${ty} cm`);
    }
    try {
      await renderPage(doc, project, page, findMaster(project, page.layout), ctx);
    } finally {
      if (fit) internal.write("Q");
    }
  }
  return doc;
}

/**
 * Baut das Mehrseiten-PDF eines Ordners und liefert das jsPDF-Dokument. Jede
 * Seite = ein Layout in Baum-Reihenfolge. Gibt `null`, wenn der Ordner keine
 * Layouts enthält (der Aufrufer meldet das dann in der UI).
 */
export async function buildFolderPdf(project: Project, folderId: string): Promise<jsPDF | null> {
  return buildPagesPdf(project, folderPdfPages(project, folderId));
}

/** Baut das Ordner-PDF als Bytes (`null`, wenn nichts zu exportieren war). Speichern macht die Hülle. */
export async function folderPdfBytes(project: Project, folderId: string): Promise<Uint8Array | null> {
  const doc = await buildFolderPdf(project, folderId);
  if (!doc) return null;
  return pdfBytes(project, doc);
}

/** Fertige PDF-Bytes eines Dokuments; bei anonymer Abgabe ohne Erzeuger-/Datumsangaben ([208]). */
export function pdfBytes(project: Project, doc: jsPDF): Uint8Array {
  return finishPdfBytes(project, new Uint8Array(doc.output("arraybuffer")));
}
