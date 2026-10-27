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
import type { Layout, LayoutAnnotation, MasterLayout, Project } from "../model/types";
import { generatePlan } from "../plan/generatePlan";
import { planToPrintSvg } from "./planToPrintSvg";
import { saveBinaryFile } from "../io/saveFile";
import { wrapDocToLines, type SvgLine } from "../text/renderHtml";
import { docFromText } from "../text/richText";
import {
  findMaster,
  findSnapshot,
  folderPdfPages,
  resolveTitleBlock,
  resolveViewportScale,
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

/** "#rrggbb"/"#rgb" → [r,g,b] (0..255); ungültige Eingabe fällt auf Tinte zurück. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (full.length !== 6 || !Number.isFinite(n)) return [17, 17, 17];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Bildformat aus dem MIME-Teil der Data-URL ableiten (jsPDF `addImage` braucht es explizit). */
function imageFormatFromDataUrl(src: string): string {
  const ext = (/^data:image\/(\w+)/i.exec(src)?.[1] ?? "png").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "JPEG";
  if (ext === "webp") return "WEBP";
  return "PNG";
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Baut EIN Mini-SVG (Blattgrösse) mit allen Text-Markups einer Seite — reiche
 * Docs (mehrere Absätze/gemischte Formatierung) + Wortumbruch bei gesetzter
 * Rahmenbreite, exakt wie `LayoutSheet.tsx`s `AnnotationSvg`. Ein gemeinsamer
 * `doc.svg()`-Aufruf statt einem je Annotation (einfacher, ein Layout-Pass).
 * `null`, wenn die Seite keine Text-Markups trägt.
 */
function buildAnnotationTextsSvg(
  annotations: LayoutAnnotation[],
  sheetW: number,
  sheetH: number,
): SVGSVGElement | null {
  const texts = annotations.filter(
    (a): a is Extract<LayoutAnnotation, { kind: "text" }> => a.kind === "text",
  );
  if (texts.length === 0) return null;

  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(sheetW));
  svg.setAttribute("height", String(sheetH));
  svg.setAttribute("viewBox", `0 0 ${sheetW} ${sheetH}`);

  for (const ann of texts) {
    const doc = ann.doc ?? docFromText(ann.text);
    const lineHeight = ann.heightMm * 1.25;
    const lines: SvgLine[] = wrapDocToLines(doc, {
      x: 0,
      y: 0,
      lineHeight,
      unitPerPt: 25.4 / 72,
      basePt: (ann.heightMm / 25.4) * 72,
      color: ann.color ?? "#111111",
      ...(ann.widthMm && ann.widthMm > 0 ? { wrapWidthUnits: ann.widthMm } : {}),
    });
    let y = ann.yMm;
    const el = document.createElementNS(SVG_NS, "text");
    lines.forEach((line, k) => {
      if (k > 0) y += line.lineHeight;
      const anchor = line.align === "center" ? "middle" : line.align === "right" ? "end" : "start";
      const x = !ann.widthMm
        ? ann.xMm
        : line.align === "center"
          ? ann.xMm + ann.widthMm / 2
          : line.align === "right"
            ? ann.xMm + ann.widthMm
            : ann.xMm;
      const lineTspan = document.createElementNS(SVG_NS, "tspan");
      lineTspan.setAttribute("x", String(x));
      lineTspan.setAttribute("y", String(y));
      lineTspan.setAttribute("text-anchor", anchor);
      if (line.tspans.length === 0) {
        lineTspan.textContent = "​";
      } else {
        for (const ts of line.tspans) {
          const run = document.createElementNS(SVG_NS, "tspan");
          run.setAttribute("font-size", String(ts.fontSize));
          run.setAttribute("fill", ts.fill);
          if (ts.fontWeight) run.setAttribute("font-weight", ts.fontWeight);
          if (ts.fontStyle) run.setAttribute("font-style", ts.fontStyle);
          run.setAttribute("font-family", ts.fontFamily ?? "Helvetica, Arial, sans-serif");
          if (ts.textDecoration) run.setAttribute("text-decoration", ts.textDecoration);
          run.textContent = ts.text;
          lineTspan.appendChild(run);
        }
      }
      el.appendChild(lineTspan);
    });
    svg.appendChild(el);
  }
  return svg;
}

/**
 * Zeichnet die 2D-Markups (Linie/Rechteck/Bild) EINER Seite direkt via jsPDF-
 * Vektorprimitive — dieselbe Schicht wie `LayoutSheet.tsx`s Annotations-SVG,
 * hier aber ÜBER Viewports UND Master gezeichnet (Aufrufreihenfolge in
 * `renderPage`), analog zur Zeichenreihenfolge im In-Viewport-Editor.
 */
function drawAnnotationShapes(doc: jsPDF, layout: Layout): void {
  for (const ann of layout.annotations ?? []) {
    if (ann.kind === "line") {
      const [r, g, b] = hexToRgb(ann.color ?? "#111111");
      doc.setDrawColor(r, g, b);
      doc.setLineWidth(ann.weightMm ?? 0.25);
      doc.line(ann.x1Mm, ann.y1Mm, ann.x2Mm, ann.y2Mm);
    } else if (ann.kind === "rect") {
      const [r, g, b] = hexToRgb(ann.color ?? "#111111");
      doc.setDrawColor(r, g, b);
      doc.setLineWidth(ann.weightMm ?? 0.25);
      doc.rect(ann.xMm, ann.yMm, ann.widthMm, ann.heightMm);
    } else if (ann.kind === "image" && ann.widthMm > 0 && ann.heightMm > 0 && ann.src) {
      try {
        doc.addImage(
          ann.src,
          imageFormatFromDataUrl(ann.src),
          ann.xMm,
          ann.yMm,
          ann.widthMm,
          ann.heightMm,
        );
      } catch {
        // Defekte/leere Data-URL überspringt nur dieses Bild, nicht die Seite.
      }
    }
  }
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

  // 2D-Markups (Linie/Rechteck/Bild/Text) — ÜBER Viewports + Master, wie im
  // In-Viewport-Editor (LayoutSheet.tsx). Fehlte bisher komplett im Export.
  drawAnnotationShapes(doc, layout);
  const textsSvg = buildAnnotationTextsSvg(layout.annotations ?? [], widthMm, heightMm);
  if (textsSvg) {
    try {
      await doc.svg(textsSvg, { x: 0, y: 0, width: widthMm, height: heightMm });
    } catch {
      // Rich-Text-Rendering eines Markups darf die Seite nicht killen.
    }
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
