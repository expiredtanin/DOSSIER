// Test-Hilfen für Importe ([K4] S4): die Import-Form des Kerns als Objekt ansehen (`import_drawing_view`, Form wie
// früher `DxfImportResult`), die Rohdaten des IFC-Lesers ansehen und Dateien über das Kern-Dokument ins Projekt
// übernehmen.

import type { Contour, Drawing2D, ImportedMesh, ImportedText, Project } from "../model/types";
import { core } from "../engine/coreWasm";
import { ProjectDocument, type DrawingImportDecision } from "../core/document";
import { addedItems } from "../core/opsBuild";
import { parseDxf } from "./dxfParser";
import type { ImportDiagnostics, ImportSource, ParsedImport } from "./importSource";
import { importIfcFlat, readIfcFlat, type IfcClassificationRef, type IfcImportReport } from "./ifcImport";
import { readMesh, type MeshReadOptions } from "./meshImport";

/** Kontur der Leseansicht (mit Bögen einer Polylinie). */
export interface ViewContour extends Contour {
  bulgePolyline?: { pts: { x: number; y: number }[]; bulge: number[] };
}

/** Leseansicht der Import-Form. */
export interface ImportView {
  meshes: ImportedMesh[];
  contours: { type: "contourSet"; categoryCode: string; contours: ViewContour[] }[];
  texts: ImportedText[];
  layerColors: Record<string, string>;
  layerLineWeights: Record<string, number>;
  layerFillColors: Record<string, string>;
  layerDashes: Record<string, number[]>;
  diagnostics: ImportDiagnostics;
  insUnits?: number;
  unitScale?: number;
  layouts?: { name: string; entities: number }[];
  layout?: string;
  recovered: boolean;
}

export function viewImport(src: ImportSource): ImportView {
  const out = core().import_drawing_view(src.geom, JSON.stringify(src.strings), JSON.stringify(src.source), Date.now());
  if (out.startsWith("\u0001")) throw new Error(out.slice(1));
  return JSON.parse(out) as ImportView;
}

/** DXF/DWG lesen (Format-Modul geladen) und als Leseansicht liefern. */
export function inspectDxf(input: string | ArrayBuffer | Uint8Array, layout?: string): ImportView {
  return viewImport(parseDxf(input, layout).src);
}

/**
 * Gelesene Datei über das Kern-Dokument ins Projekt übernehmen (Standard: neue Zeichnung, Layer als Kategorien,
 * Meshes als Kontext). Wirft bei zurückgewiesener Änderung.
 */
export function importInto(project: Project, parsed: ParsedImport, decision: Partial<DrawingImportDecision> = {}) {
  const doc = new ProjectDocument(project);
  const r = doc.importDrawing(
    project,
    parsed.src,
    {
      target: { kind: "new", name: "Import" },
      categoryMode: "byLayer",
      activeCategoryCode: project.layers[0]?.code ?? "20",
      importMeshes: true,
      levelNameTemplate: "Zeichnung {n}",
      parentName: "Import",
      dashStyleTemplate: "PDF-Strich {pattern} mm",
      ...decision,
    },
    Date.now(),
  );
  doc.close();
  if ("problems" in r) throw new Error(r.problems.join("; "));
  const drawings: Drawing2D[] = r.project.drawings2d.filter((d) => d.levelId === r.levelId);
  return { ...r, drawings };
}

// ── IFC und Meshes ──────────────────────────────────────────────────────────

/** Ein gelesenes IFC-Bauteil (Leseansicht des Lesers für Tests). */
export interface IfcProductView {
  globalId: string;
  ifcClass: string;
  name: string | null;
  storey: string | null;
  color: [number, number, number, number] | null;
  classifications?: IfcClassificationRef[];
  positions: Float64Array;
  indices: Uint32Array;
}

/** Roh erkanntes Bauteil (`meta.elements.elements` des Lesers). */
export interface IfcRawElement {
  kind: "wall" | "opening" | "slab" | "column" | "space";
  globalId: string;
  ifcClass: string;
  name: string | null;
  openingKind?: "door" | "window" | "hole";
  sia?: string | null;
  longName?: string | null;
  classifications?: IfcClassificationRef[];
  at: number;
  n: number;
}

/** IFC lesen (Format-Modul, Web-Worker wenn vorhanden) und Bericht, Bauteile, roh erkannte Elemente ansehen. */
export async function inspectIfc(bytes: Uint8Array, elements = false) {
  const flat = await readIfcFlat(bytes, elements);
  const meta = JSON.parse(flat.meta) as Omit<IfcImportReport, "products"> & {
    products: (Omit<IfcProductView, "positions" | "indices"> & { positionCount: number; indexCount: number })[];
    elements?: { storeys: { name: string; elevation: number }[]; elements: IfcRawElement[]; kept: Record<string, number> };
  };
  let po = 0;
  let io = 0;
  const products: IfcProductView[] = meta.products.map(({ positionCount, indexCount, ...p }) => {
    const out = { ...p, positions: flat.positions.subarray(po, po + positionCount), indices: flat.indices.subarray(io, io + indexCount) };
    po += positionCount;
    io += indexCount;
    return out;
  });
  const report: IfcImportReport = { ...meta, products: products.length };
  return { flat, meta, report, products, raw: meta.elements?.elements ?? [], kept: meta.elements?.kept ?? {} };
}

/** IFC über das Kern-Dokument ins Projekt übernehmen ([B3] Meshes bzw. `elements: true` [B4] Bauteile). */
export async function importIfcInto(
  project: Project,
  bytes: Uint8Array,
  opts: { fileName?: string; group?: "auto" | "product" | "class"; elements?: boolean } = {},
) {
  const flat = await importIfcFlat(bytes, opts.elements === true);
  const doc = new ProjectDocument(project);
  const r = doc.importIfc(project, flat, { fileName: opts.fileName ?? "haus.ifc", ...(opts.group ? { group: opts.group } : {}), elements: opts.elements === true }, Date.now());
  doc.close();
  if ("problems" in r) throw new Error(r.problems.join("; "));
  return { ...r, meshes: addedItems(r.ops, "context") as ImportedMesh[] };
}

/** Mesh-Datei lesen und über das Kern-Dokument als Kontext-Meshes übernehmen. */
export async function importMeshInto(
  project: Project,
  bytes: Uint8Array,
  name: string,
  opts: MeshReadOptions & { placement?: "center" | "original"; group?: "auto" | "object" | "merge" } = {},
) {
  const read = await readMesh(bytes, name, opts);
  const doc = new ProjectDocument(project);
  const r = doc.importMesh(project, read.flat, { fileName: name, ...(opts.placement ? { placement: opts.placement } : {}), ...(opts.group ? { group: opts.group } : {}) }, Date.now());
  doc.close();
  if ("problems" in r) throw new Error(r.problems.join("; "));
  return { ...r, read, meshes: addedItems(r.ops, "context") as ImportedMesh[] };
}
