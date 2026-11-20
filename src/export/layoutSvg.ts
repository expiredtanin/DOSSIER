// Layout-Blatt als SVG (headless, `dossier-cli sheet`): dieselben Pläne wie der PDF-Export (`layoutPdf.ts`:
// `viewportPlanSource`, `sheetDrawingPrint`, Druck-Serializer `planToPrintSvg`) und dieselben Blatt-Elemente
// (Rahmen, Schriftfeld bzw. Plakat-Kopfzeile, Massstabsangaben, Legenden, Bilder, Tabellen) — nur als SVG-Text statt jsPDF.
// Vektor-PDF braucht jsPDF + svg2pdf und damit ein echtes DOM (Browser/Tauri): hier nicht.

import type { Layout, MasterLayout, Project } from "../model/types";
import { t } from "../i18n/translate";
import { effectiveSheetSizeMm, findMaster, resolveTitleBlock, type ResolvedTitleBlock } from "../model/layoutModel";
import { imageGeometry } from "../model/layoutImages";
import { posterHeaderItems, viewportScaleLabel, viewportVariantLabel } from "../model/posterTemplates";
import { legendPlan, legendPrintSvg } from "./legendSvg";
import { clip, sheetDrawingPrint, viewportPlanSource } from "./layoutPdf";
import { planToPrintSvg } from "./planToPrintSvg";
import { sheetTables, PDF_TABLE_FONT } from "./sheetTable";
import { serializeSvg, withHeadlessDom } from "./headlessDom";
import type { PresentationLabels } from "../plan/presentationSheet";

const INK = "#111111";
const FONT = "Inter, Helvetica, Arial, sans-serif";
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number): string => String(Math.round(v * 1000) / 1000);

/** Beschriftungen des Präsentationsblatts (de/en über `t`), gemeinsam für App und CLI. */
export function presentationSheetLabels(format: string): PresentationLabels {
  return {
    sheetName: t("presentation.sheetName"),
    masterName: t("presentation.masterName", { format }),
    north: t("presentation.north"),
    northGroup: t("presentation.northGroup"),
    scaleBarGroup: t("presentation.scaleBarGroup"),
    situation: t("presentation.situation"),
    tableAreas: t("presentation.table.areas"),
    tableSiteProof: t("presentation.table.siteProof"),
    tableUnits: t("presentation.table.units"),
    imagePlaceholder: t("presentation.image.placeholder"),
    imageHint: t("presentation.image.hint"),
    axo: t("presentation.axo"),
  };
}

function textEl(x: number, y: number, s: string, size: number, o: { bold?: boolean; italic?: boolean; anchor?: "start" | "middle" | "end"; fill?: string; family?: string } = {}): string {
  const a = [`x="${num(x)}"`, `y="${num(y)}"`, `font-size="${num(size)}"`, `font-family="${o.family ?? FONT}"`, `fill="${o.fill ?? INK}"`];
  if (o.bold) a.push('font-weight="bold"');
  if (o.italic) a.push('font-style="italic"');
  if (o.anchor && o.anchor !== "start") a.push(`text-anchor="${o.anchor}"`);
  return `<text ${a.join(" ")}>${esc(s)}</text>`;
}

/** Schriftfeld unten rechts (Mass wie `drawTitleBlock` im PDF). */
function titleBlockSvg(w: number, h: number, tb: ResolvedTitleBlock, layout: Layout): string {
  const bw = 70;
  const bh = 30;
  const x = w - bw - 6;
  const y = h - bh - 6;
  const fmt = `${layout.paper.toUpperCase()} ${layout.orientation === "landscape" ? "quer" : "hoch"}`;
  const o: string[] = [
    `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="#fff" stroke="${INK}" stroke-width="0.35"/>`,
    `<line x1="${x}" y1="${y + 8}" x2="${x + bw}" y2="${y + 8}" stroke="${INK}" stroke-width="0.2"/>`,
    `<line x1="${x}" y1="${y + bh - 7}" x2="${x + bw}" y2="${y + bh - 7}" stroke="${INK}" stroke-width="0.2"/>`,
    textEl(x + 3, y + 5.6, clip(tb.projectName, 28), 3.2, { bold: true }),
    textEl(x + bw - 3, y + 5.6, tb.planNumber, 3.2, { bold: true, anchor: "end" }),
    textEl(x + 3, y + 13, clip(tb.sheetName, 36), 2.8),
  ];
  if (tb.revision) o.push(textEl(x + bw - 3, y + 13, `${t("layouts.revision.short")} ${tb.revision}`, 2.5, { anchor: "end" }));
  if (tb.author) o.push(textEl(x + 3, y + 18, clip(tb.author, 40), 2.5, { fill: "#444" }));
  o.push(textEl(x + 3, y + bh - 2.4, tb.scale, 2.8), textEl(x + bw - 3, y + bh - 2.4, `${tb.date} · ${fmt}`, 2.5, { anchor: "end" }));
  return o.join("");
}

function posterHeaderSvg(project: Project, layout: Layout, master: MasterLayout, w: number, h: number): string {
  return posterHeaderItems(project, layout, master, { w, h })
    .map((it) =>
      it.kind === "rect"
        ? `<rect x="${num(it.x)}" y="${num(it.y)}" width="${num(it.w)}" height="${num(it.h)}" fill="none" stroke="${INK}" stroke-width="${num(it.stroke)}"/>`
        : textEl(it.x, it.y, it.text, it.sizeMm, { bold: it.bold, anchor: it.align === "left" ? "start" : it.align === "center" ? "middle" : "end" }),
    )
    .join("");
}

/** Eingebettetes SVG-Element an Blatt-Position `x,y` (verschachteltes `<svg>` schneidet am eigenen Rahmen ab). */
function nested(svg: SVGSVGElement, x: number, y: number, w: number, h: number): string {
  svg.setAttribute("x", num(x));
  svg.setAttribute("y", num(y));
  svg.setAttribute("width", num(w));
  svg.setAttribute("height", num(h));
  svg.setAttribute("overflow", "hidden");
  return serializeSvg(svg);
}

export interface LayoutSvgOptions {
  /** Massstab (1:N) für alle Viewports statt dem eigenen. */
  scaleOverride?: number;
}

/**
 * Das Blatt `layout` als SVG-Text (Papier-mm, Ursprung oben links): Viewports, Bilder, Massstabsangaben, Legenden,
 * Rahmen + Schriftfeld/Kopfzeile, Tabellen, Blatt-Zeichnung — Stapelung wie im PDF. Ein Viewport, der nicht rendert,
 * lässt nur sich selbst weg (Meldung in `warnings`).
 */
export async function buildLayoutSvg(project: Project, layout: Layout, opts: LayoutSvgOptions = {}): Promise<{ svg: string; widthMm: number; heightMm: number; warnings: string[] }> {
  const master = findMaster(project, layout);
  const { w, h } = effectiveSheetSizeMm(master ?? layout);
  const warnings: string[] = [];
  const parts: string[] = [];
  await withHeadlessDom(async () => {
    for (const vp of layout.viewports) {
      const src = viewportPlanSource(project, vp, opts.scaleOverride);
      if (!src) {
        warnings.push(`Viewport ${vp.id}: Ausschnitt ${vp.snapshotId} fehlt`);
        continue;
      }
      try {
        const plan = await src.planOf(src.codes);
        const print = planToPrintSvg(plan, { scaleDenominator: src.scaleN, pageWidthMm: vp.widthMm, pageHeightMm: vp.heightMm, transparent: false, bounds: src.centered ?? undefined });
        parts.push(nested(print.svg, vp.xMm, vp.yMm, vp.widthMm, vp.heightMm));
      } catch (e) {
        warnings.push(`Viewport ${vp.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const img of layout.images ?? []) {
      if (!/^data:image\/(png|jpeg);base64,/.test(img.src) || img.widthMm <= 0 || img.heightMm <= 0) continue;
      const g = imageGeometry(img);
      const id = `clip-${esc(img.id)}`;
      parts.push(`<clipPath id="${id}"><rect x="${num(g.clip.x)}" y="${num(g.clip.y)}" width="${num(g.clip.w)}" height="${num(g.clip.h)}"/></clipPath><image clip-path="url(#${id})" href="${img.src}" x="${num(g.draw.x)}" y="${num(g.draw.y)}" width="${num(g.draw.w)}" height="${num(g.draw.h)}" preserveAspectRatio="none"/>`);
    }
    if (master?.viewportScaleLabels || project.designOptionSets?.length) {
      for (const vp of layout.viewports) {
        const l = master?.viewportScaleLabels ? viewportScaleLabel(project, vp, { w, h }, opts.scaleOverride) : viewportVariantLabel(project, vp, { w, h });
        if (l) parts.push(textEl(l.x, l.y, l.text, l.sizeMm));
      }
    }
    for (const lg of layout.legends ?? []) {
      try {
        const lp = legendPlan(project, layout, lg);
        if (lp) parts.push(nested(legendPrintSvg(lp), lp.xMm, lp.yMm, lp.widthMm, lp.heightMm));
      } catch (e) {
        warnings.push(`Legende ${lg.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (master) {
      if (master.border ?? true) parts.push(`<rect x="5" y="5" width="${w - 10}" height="${h - 10}" fill="none" stroke="${INK}" stroke-width="0.35"/>`);
      parts.push(master.posterHeader ? posterHeaderSvg(project, layout, master, w, h) : titleBlockSvg(w, h, resolveTitleBlock(project, layout, master), layout));
    }
    try {
      for (const tb of sheetTables(project, layout.id)) {
        for (const p of tb.prims) {
          if (p.k === "line") parts.push(`<line x1="${num(p.x1)}" y1="${num(p.y1)}" x2="${num(p.x2)}" y2="${num(p.y2)}" stroke="${INK}" stroke-width="${num(p.w)}"/>`);
          else parts.push(textEl(p.x, p.y, p.s, p.size, { bold: p.bold, italic: p.italic, family: `'${PDF_TABLE_FONT[p.font]}', ${FONT}`, anchor: p.align === "r" ? "end" : p.align === "c" ? "middle" : "start" }));
        }
      }
    } catch (e) {
      warnings.push(`Tabellen: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const drawing = sheetDrawingPrint(project, layout, w, h);
      if (drawing) parts.push(nested(drawing, 0, 0, w, h));
    } catch (e) {
      warnings.push(`Blatt-Zeichnung: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>${parts.join("")}</svg>\n`;
  return { svg, widthMm: w, heightMm: h, warnings };
}
