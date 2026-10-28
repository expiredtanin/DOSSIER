// IFC-Import als Mesh ([B3]): dünne Fassade über `import_ifc` im Format-Modul (`src-tauri/fileio`,
// `ifc_import.rs`). Jedes IFC-Bauteil mit Körper wird zu einem `ImportedMesh` der Kontext-Schicht
// (wie der STEP-Import, `stepImport.ts`); echte Bauteile (Wand, Decke …) kommen mit [B4].
//
// Gruppierung: je Bauteil ein Mesh (anwählbar, Name/Geschoss/GlobalId bleiben erhalten, im
// Kontext-Panel nach IFC-Klasse gruppiert über `layer`). Bei sehr vielen Bauteilen (> `MAX_SINGLE`)
// werden Bauteile gleicher Klasse und gleichen Geschosses zusammengelegt, damit Projektdatei und
// Kontext-Panel handhabbar bleiben.
//
// Koordinaten: Meter, Z = Höhe, unverändert aus der Datei — ausser die Datei liegt in
// Landeskoordinaten und das Projekt hat einen Standort-Bezug: dann wird auf den Modell-Nullpunkt
// zurückgeschoben (Gegenstück zu `projectToWorldCoords` beim Export).

import { loadFileio } from "../engine/fileioWasm";
import { GENERIC_IMPORT_CATEGORY } from "../model/contextCategories";
import type { ImportedMesh } from "../model/types";

/** Ein gelesenes IFC-Bauteil. */
export interface IfcProduct {
  globalId: string;
  /** IFC-Klasse, z. B. `IfcWall`. */
  ifcClass: string;
  name: string | null;
  storey: string | null;
  /** RGBA 0..1 aus IfcStyledItem/Material, falls vorhanden. */
  color: [number, number, number, number] | null;
  /** x,y,z in Metern (Z = Höhe). */
  positions: Float64Array;
  indices: Uint32Array;
}

/** Bericht des Imports: was gelesen, was übersprungen wurde. */
export interface IfcImportReport {
  schema: string;
  lengthScale: number;
  products: number;
  /** Übersprungene Geometrie je IFC-Typ (z. B. `IFCSWEPTDISKSOLID`). */
  skippedItems: Record<string, number>;
  /** Bewusst ausgelassene Bauteile je Klasse (Öffnungen, Räume …). */
  skippedProducts: Record<string, number>;
  productsWithoutGeometry: number;
  simplifiedBooleans: number;
  voidsIgnored: number;
  parseErrors: number;
  truncated: boolean;
}

interface RawProduct {
  globalId: string;
  ifcClass: string;
  name: string | null;
  storey: string | null;
  color: [number, number, number, number] | null;
  positionCount: number;
  indexCount: number;
}

/** Liest IFC-Bytes. Wirft bei unlesbarer Datei (Meldung aus Rust). */
export async function readIfc(bytes: Uint8Array): Promise<{ products: IfcProduct[]; report: IfcImportReport }> {
  const m = await loadFileio();
  const r = m.import_ifc(bytes);
  try {
    const meta = JSON.parse(r.meta) as Omit<IfcImportReport, "products"> & { products: RawProduct[] };
    const pos = r.positions();
    const idx = r.indices();
    let po = 0;
    let io = 0;
    const products: IfcProduct[] = [];
    for (const p of meta.products) {
      products.push({
        globalId: p.globalId,
        ifcClass: p.ifcClass,
        name: p.name,
        storey: p.storey,
        color: p.color,
        positions: pos.subarray(po, po + p.positionCount),
        indices: idx.subarray(io, io + p.indexCount),
      });
      po += p.positionCount;
      io += p.indexCount;
    }
    return { products, report: { ...meta, products: products.length } };
  } finally {
    r.free();
  }
}

/** Ab so vielen Bauteilen wird je Klasse + Geschoss zusammengelegt. */
export const MAX_SINGLE = 2000;

export interface IfcToMeshesOptions {
  /** LV95-Ursprung des Projekts (`projectGeoOrigin`), sonst null. */
  geoOrigin?: { e: number; n: number } | null;
  /** "product" = je Bauteil, "class" = je Klasse + Geschoss, "auto" (Standard) nach `MAX_SINGLE`. */
  group?: "product" | "class" | "auto";
}

let counter = 0;

/** Verschiebung, falls die Datei in Landeskoordinaten liegt und das Projekt einen Bezug hat. */
function geoShift(products: IfcProduct[], origin: { e: number; n: number } | null | undefined): [number, number] {
  if (!origin) return [0, 0];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of products) {
    for (let i = 0; i + 2 < p.positions.length; i += 3 * 64) {
      sx += p.positions[i];
      sy += p.positions[i + 1];
      n++;
    }
  }
  if (n === 0) return [0, 0];
  const cx = sx / n;
  const cy = sy / n;
  const nearOrigin = Math.hypot(cx - origin.e, cy - origin.n) < Math.hypot(cx, cy);
  return nearOrigin ? [-origin.e, -origin.n] : [0, 0];
}

/** Bauteile → Kontext-Meshes (Kategorie „Situation" wie STEP; `layer` = IFC-Klasse). */
export function ifcToImportedMeshes(products: IfcProduct[], fileName: string, opts: IfcToMeshesOptions = {}): ImportedMesh[] {
  const base = fileName.replace(/\.[^.]+$/, "") || "IFC";
  const [dx, dy] = geoShift(products, opts.geoOrigin);
  const stamp = Date.now().toString(36);
  const group = opts.group ?? "auto";
  const perProduct = group === "product" || (group === "auto" && products.length <= MAX_SINGLE);

  const toArrays = (parts: IfcProduct[]): { positions: number[]; indices: number[] } => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const p of parts) {
      const off = positions.length / 3;
      for (let i = 0; i + 2 < p.positions.length; i += 3) {
        positions.push(p.positions[i] + dx, p.positions[i + 1] + dy, p.positions[i + 2]);
      }
      for (let i = 0; i < p.indices.length; i++) indices.push(p.indices[i] + off);
    }
    return { positions, indices };
  };

  if (perProduct) {
    return products.map((p) => ({
      id: `imported-ifc-${stamp}-${counter++}`,
      type: "importedMesh" as const,
      name: [p.storey, p.name || p.ifcClass].filter(Boolean).join(": ") + (p.globalId ? ` [${p.globalId}]` : ""),
      layer: p.ifcClass,
      categoryCode: GENERIC_IMPORT_CATEGORY.code,
      ...toArrays([p]),
    }));
  }
  const groups = new Map<string, IfcProduct[]>();
  for (const p of products) {
    const key = `${p.ifcClass}\u0000${p.storey ?? ""}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.values()].map((parts) => ({
    id: `imported-ifc-${stamp}-${counter++}`,
    type: "importedMesh" as const,
    name: `${base}: ${[parts[0].storey, parts[0].ifcClass].filter(Boolean).join(" ")} (${parts.length})`,
    layer: parts[0].ifcClass,
    categoryCode: GENERIC_IMPORT_CATEGORY.code,
    ...toArrays(parts),
  }));
}

/** Datei-Bytes → Kontext-Meshes + Bericht. */
export async function ifcBytesToImportedMeshes(
  bytes: Uint8Array,
  fileName: string,
  opts: IfcToMeshesOptions = {},
): Promise<{ meshes: ImportedMesh[]; report: IfcImportReport }> {
  const { products, report } = await readIfc(bytes);
  return { meshes: ifcToImportedMeshes(products, fileName, opts), report };
}

/** Bericht als kurzer Text; `tr` übersetzt (Kern kennt kein i18n, die Hülle reicht `t` herein). */
export function formatIfcReport(
  r: IfcImportReport,
  tr: (key: "ifc.import.done" | "ifc.import.skipped" | "ifc.import.voids" | "ifc.import.booleans" | "ifc.import.truncated", vars?: Record<string, string | number>) => string,
): string {
  const parts = [tr("ifc.import.done", { n: r.products, schema: r.schema || "IFC" })];
  const skipped = Object.entries(r.skippedItems)
    .map(([k, v]) => `${k} ×${v}`)
    .join(", ");
  const without = r.productsWithoutGeometry;
  if (skipped || without) parts.push(tr("ifc.import.skipped", { n: without, list: skipped || "–" }));
  if (r.voidsIgnored) parts.push(tr("ifc.import.voids", { n: r.voidsIgnored }));
  if (r.simplifiedBooleans) parts.push(tr("ifc.import.booleans", { n: r.simplifiedBooleans }));
  if (r.truncated) parts.push(tr("ifc.import.truncated"));
  return parts.join(" · ");
}
