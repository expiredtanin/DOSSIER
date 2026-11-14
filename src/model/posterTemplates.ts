// Plakat-Vorlagen für Wettbewerbs-Abgaben ([208]): A0/A1 hoch und quer. Eine Vorlage ist ein Masterlayout
// (`MasterLayout.template`) mit Gestaltungsraster (Hilfslinien), Plakat-Kopfzeile (Kennwort-Feld, Projekttitel,
// „Plan x/n") und Massstabsangabe unter jedem Viewport; ein Blatt „aus Vorlage" ist ein Layout, das an diesen
// Master gebunden ist. Masse und Kopfzeile rechnet der Kern (`src-tauri/core/src/layout_poster.rs`).
//
// Bezeichner englisch, Kommentare deutsch.

import type { Layout, LayoutOrientation, LayoutPaperFormat, MasterLayout, Project } from "./types";
import { core } from "../engine/coreWasm";
import { t } from "../i18n/translate";
import { findSnapshot, resolveTitleBlock, resolveViewportScale, sheetSizeMm } from "./layoutModel";

export interface PosterTemplate {
  /** Schlüssel in `MasterLayout.template`. */
  key: string;
  paper: LayoutPaperFormat;
  orientation: LayoutOrientation;
}

export const POSTER_TEMPLATES: readonly PosterTemplate[] = [
  { key: "poster-a0-portrait", paper: "a0", orientation: "portrait" },
  { key: "poster-a0-landscape", paper: "a0", orientation: "landscape" },
  { key: "poster-a1-portrait", paper: "a1", orientation: "portrait" },
  { key: "poster-a1-landscape", paper: "a1", orientation: "landscape" },
];

export function posterTemplate(key: string): PosterTemplate | undefined {
  return POSTER_TEMPLATES.find((p) => p.key === key);
}

/** Anzeigename einer Vorlage („Plakat A1 quer"). */
export function posterTemplateLabel(tpl: PosterTemplate): string {
  return t("poster.template.name", {
    format: tpl.paper.toUpperCase(),
    orientation: tpl.orientation === "landscape" ? t("layouts.landscape") : t("layouts.portrait"),
  });
}

export interface PosterMetrics {
  widthMm: number;
  heightMm: number;
  marginMm: number;
  headerHeightMm: number;
  columns: number;
  gutterMm: number;
  contentTopMm: number;
  guides: { axis: "x" | "y"; posMm: number }[];
}

/** Ränder, Spalten und Hilfslinien für ein Blatt `widthMm`×`heightMm`. */
export function posterMetrics(widthMm: number, heightMm: number): PosterMetrics {
  const out = core().layout_call("posterMetrics", JSON.stringify({ widthMm, heightMm }));
  if (out === "") throw new Error("Kern: Plakat-Masse nicht berechenbar");
  return JSON.parse(out) as PosterMetrics;
}

/** Master der Vorlage (Titelblock leer, Hilfslinien des Rasters, Kopfzeile, Massstabsangaben). */
export function createPosterMaster(id: string, tpl: PosterTemplate): MasterLayout {
  const size = sheetSizeMm(tpl.paper, tpl.orientation);
  const m = posterMetrics(size.w, size.h);
  return {
    id,
    name: posterTemplateLabel(tpl),
    paper: tpl.paper,
    orientation: tpl.orientation,
    titleBlock: {},
    border: false,
    template: tpl.key,
    posterHeader: true,
    viewportScaleLabels: true,
    guides: m.guides,
  };
}

/** Der vorhandene Master einer Vorlage im Projekt (Plakate teilen einen Master je Vorlage). */
export function findPosterMaster(project: Pick<Project, "masterLayouts">, key: string): MasterLayout | undefined {
  return (project.masterLayouts ?? []).find((m) => m.template === key);
}

export type HeaderItem =
  | { kind: "rect"; x: number; y: number; w: number; h: number; stroke: number }
  | { kind: "text"; x: number; y: number; text: string; sizeMm: number; align: "left" | "center" | "right"; bold: boolean };

/**
 * Zeichenelemente der Plakat-Kopfzeile eines Blatts: Kennwort-Feld, Projekttitel (bei anonymer Abgabe leer) und
 * „Plan x/n". Bildschirm (SVG) und PDF zeichnen dieselben Elemente.
 */
export function posterHeaderItems(project: Project, layout: Layout, master: MasterLayout, sheet: { w: number; h: number }): HeaderItem[] {
  const tb = resolveTitleBlock(project, layout, master);
  const title = tb.anonymous ? "" : tb.projectName;
  const planText = tb.planCount > 0 ? t("poster.header.plan", { x: tb.planIndex, n: tb.planCount }) : "";
  const out = core().layout_call(
    "posterHeader",
    JSON.stringify({ widthMm: sheet.w, heightMm: sheet.h, keywordLabel: t("poster.header.keyword"), keyword: tb.keyword, title, planText }),
  );
  return out === "" ? [] : (JSON.parse(out) as HeaderItem[]);
}

/** Schrifthöhe und Abstand der Grundlinie unter dem Viewport-Rahmen (Papier-mm) der Massstabsangabe. */
export function scaleLabelMetrics(sheet: { w: number; h: number }): { sizeMm: number; dyMm: number } {
  const sizeMm = Math.max(3, Math.min(sheet.w, sheet.h) / 140);
  return { sizeMm, dyMm: sizeMm * 1.3 };
}

/** Massstabsangabe unter einem Viewport: Text, Lage (Papier-mm, Grundlinie) und Schrifthöhe. */
export function viewportScaleLabel(
  project: Project,
  vp: Layout["viewports"][number],
  sheet: { w: number; h: number },
  scaleOverride?: number,
): { text: string; x: number; y: number; sizeMm: number } | null {
  const snap = findSnapshot(project, vp.snapshotId);
  if (!snap) return null;
  const n = scaleOverride ?? resolveViewportScale(vp, snap);
  const { sizeMm, dyMm } = scaleLabelMetrics(sheet);
  return { text: `1:${n}`, x: vp.xMm, y: vp.yMm + vp.heightMm + dyMm, sizeMm };
}
