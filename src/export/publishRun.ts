// Publikationssatz ausführen ([79]): erzeugt die Dateien des Plans (`publishSet.ts`) — PDF mit Ebenen/Index
// (`layoutPdf.ts`), DXF/DWG mit den Papierbereichen der Blätter des Satzes. Braucht ein DOM (jsPDF/svg2pdf);
// Speichern, Revisionen und Protokoll macht der Aufrufer (`publishOps`).

import JSZip from "jszip";
import type { Layout, Project, PublishSet, ViewSnapshot } from "../model/types";
import { collectVisibleCodes } from "../model/types";
import { generatePlan } from "../plan/generatePlan";
import { sheetLevelOf } from "../model/layoutModel";
import { legendDrawings, legendEntries } from "../analysis/legend";
import { buildPagesPdf, layoutPages } from "./layoutPdf";
import { buildPlanDwg, buildPlanDxfBinary } from "./exportDxf";
import { loadFileio } from "../engine/fileioWasm";
import type { PublishPlan } from "./publishSet";
import type { FolderPdfPage } from "../model/layoutModel";

export interface PublishedFile {
  fileName: string;
  bytes: Uint8Array;
  mime: string;
}

/** Eine gespeicherte Ansicht als eigene A3-Querseite mit einem Viewport über das ganze Blatt. */
function snapshotPage(snap: ViewSnapshot): FolderPdfPage {
  const layout: Layout = {
    id: `snap-${snap.id}`,
    name: snap.name,
    paper: "a3",
    orientation: "landscape",
    viewports: [{ id: "v", snapshotId: snap.id, xMm: 10, yMm: 10, widthMm: 400, heightMm: 277 }],
  };
  return { layout, widthMm: 420, heightMm: 297 };
}

/** Das Projekt, wie es veröffentlicht wird: Revisionsindex der Blätter schon hochgezählt (Titelblock). */
export function projectForPublish(project: Project, plan: PublishPlan): Project {
  const rev = new Map(plan.sheets.map((s) => [s.layoutId, s.revision]));
  return {
    ...project,
    layouts: (project.layouts ?? []).map((l) => (rev.has(l.id) && rev.get(l.id) ? { ...l, revision: rev.get(l.id) } : l)),
  };
}

/** Legenden der Blätter als Zeichnungen auf deren Blatt-Ebene — so landen sie im DXF-Papierbereich. */
function withLegendDrawings(project: Project, layoutIds: readonly string[]): Project {
  const extra = layoutIds.flatMap((id) => {
    const layout = (project.layouts ?? []).find((l) => l.id === id);
    const level = layout && sheetLevelOf(project, id);
    if (!layout || !level) return [];
    return (layout.legends ?? []).flatMap((lg) => legendDrawings(project, lg, legendEntries(project, layout, lg), level.id).drawings);
  });
  return extra.length > 0 ? { ...project, drawings2d: [...project.drawings2d, ...extra] } : project;
}

async function cadFile(project: Project, set: PublishSet, plan: PublishPlan, fileName: string, format: "dxf" | "dwg"): Promise<PublishedFile> {
  await loadFileio();
  const layouts = plan.sheets.map((s) => s.layoutId);
  const scoped = withLegendDrawings({ ...project, layouts: (project.layouts ?? []).filter((l) => layouts.includes(l.id)) }, layouts);
  // Modell-Ebene: die des ersten gezeigten Ausschnitts, sonst die erste Nicht-Blatt-Ebene.
  const firstSnap = layouts
    .flatMap((id) => scoped.layouts?.find((l) => l.id === id)?.viewports ?? [])
    .map((vp) => (scoped.viewSnapshots ?? []).find((v) => v.id === vp.snapshotId))
    .find(Boolean);
  const levelId = firstSnap?.activeLevelId ?? scoped.drawingLevels.find((l) => !l.layoutId)?.id ?? scoped.drawingLevels[0]?.id ?? "";
  const scale = set.scaleOverride ?? 100;
  const p = generatePlan(scoped, levelId, collectVisibleCodes(scoped.layers), undefined, "fein", false, false, true, scale, true);
  const opts = { scaleDenominator: scale, paperLayout: true, levelId, title: set.name };
  const bytes = format === "dwg" ? buildPlanDwg(p, scoped, opts) : buildPlanDxfBinary(p, scoped, opts);
  return { fileName, bytes, mime: format === "dwg" ? "image/vnd.dwg" : "application/dxf" };
}

/** Erzeugt alle Dateien des Plans. */
export async function runPublish(project: Project, set: PublishSet, plan: PublishPlan): Promise<PublishedFile[]> {
  const shown = projectForPublish(project, plan);
  const out: PublishedFile[] = [];
  for (const f of plan.files) {
    if (f.format === "dxf" || f.format === "dwg") {
      out.push(await cadFile(shown, set, plan, f.fileName, f.format));
      continue;
    }
    const pages = [
      ...layoutPages(shown, f.layoutIds),
      ...f.snapshotIds.flatMap((id) => (shown.viewSnapshots ?? []).filter((v) => v.id === id).map(snapshotPage)),
    ];
    const doc = await buildPagesPdf(shown, pages, {
      layers: plan.pdfLayers,
      scaleOverride: plan.scaleOverride,
      paperOverride: plan.paperOverride,
      includeRevision: plan.includeRevision,
    });
    if (doc) out.push({ fileName: f.fileName, bytes: new Uint8Array(doc.output("arraybuffer")), mime: "application/pdf" });
  }
  return out;
}

/** Mehrere Dateien als ein ZIP; eine einzelne bleibt sie selbst. */
export async function bundlePublished(files: PublishedFile[], zipName: string): Promise<PublishedFile | null> {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];
  const zip = new JSZip();
  for (const f of files) zip.file(f.fileName, f.bytes);
  return { fileName: zipName, bytes: await zip.generateAsync({ type: "uint8array" }), mime: "application/zip" };
}
