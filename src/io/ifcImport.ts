// IFC-Import als Mesh ([B3]): dünne Fassade über `import_ifc` im Format-Modul (`src-tauri/fileio`,
// `ifc_import.rs`). Jedes IFC-Bauteil mit Körper wird zu einem `ImportedMesh` der Kontext-Schicht
// (wie der STEP-Import, `stepImport.ts`); echte Bauteile (Wand, Decke …) baut auf Wunsch
// `ifcElements.ts` ([B4]) aus `import_ifc_elements`.
//
// Gruppierung: je Bauteil ein Mesh (anwählbar, Name/Geschoss bleiben erhalten, GlobalId in
// `ifcGlobalId`, Farbe in `color`; im Kontext-Panel nach IFC-Klasse gruppiert über `layer`). Bei sehr vielen Bauteilen (> `MAX_SINGLE`)
// werden Bauteile gleicher Klasse und gleichen Geschosses zusammengelegt, damit Projektdatei und
// Kontext-Panel handhabbar bleiben.
//
// Lesen im Web-Worker (`ifcImport.worker.ts`), damit grosse Dateien die UI nicht blockieren: zurück
// kommen nur der JSON-Bericht und zwei flache Puffer (übertragen, nicht kopiert). Ohne `Worker` (Node:
// CLI, Tests) oder wenn der Worker nicht startet, wird im aufrufenden Thread gelesen.
//
// Koordinaten: Meter, Z = Höhe, unverändert aus der Datei — ausser die Datei liegt in
// Landeskoordinaten und das Projekt hat einen Standort-Bezug: dann wird auf den Modell-Nullpunkt
// zurückgeschoben (Gegenstück zu `projectToWorldCoords` beim Export).

import { loadFileio } from "../engine/fileioWasm";
import { GENERIC_IMPORT_CATEGORY } from "../model/contextCategories";
import type { ImportedMesh } from "../model/types";
import { rgbToHex } from "../model/color";

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
  /** Abgezogene Öffnungen (je Wirt und Öffnung). */
  voidsApplied: number;
  /** Öffnungen, die nicht abgezogen werden konnten. */
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

/** Rohergebnis aus Rust: Bericht (JSON) und alle Bauteile hintereinander in zwei flachen Puffern;
 *  mit `elements` dazu die Zahlen der erkannten Bauteile ([B4], `ifcElements.ts`). */
export interface IfcFlat {
  meta: string;
  positions: Float64Array;
  indices: Uint32Array;
  elementData?: Float64Array;
}

/** Worker-Protokoll (`ifcImport.worker.ts`); `elements` = echte Bauteile erkennen ([B4]). */
export type IfcWorkerRequest = { type: "parse"; data: ArrayBuffer; elements?: boolean };
export type IfcWorkerResponse = { type: "result"; flat: IfcFlat } | { type: "error"; message: string };

/** Liest IFC-Bytes mit dem geladenen Format-Modul (Worker oder aufrufender Thread). */
export async function importIfcFlat(bytes: Uint8Array, elements = false): Promise<IfcFlat> {
  const m = await loadFileio();
  const r = elements ? m.import_ifc_elements(bytes) : m.import_ifc(bytes);
  try {
    const flat: IfcFlat = { meta: r.meta, positions: r.positions(), indices: r.indices() };
    if (elements) flat.elementData = r.elementData();
    return flat;
  } finally {
    r.free();
  }
}

/** Beantwortet eine Worker-Anfrage; liefert Antwort und zu übertragende Puffer. */
export async function handleIfcWorkerRequest(req: IfcWorkerRequest): Promise<{ res: IfcWorkerResponse; transfer: Transferable[] }> {
  try {
    if (req?.type !== "parse" || !(req.data instanceof ArrayBuffer)) throw new Error("ungültige Anfrage");
    const flat = await importIfcFlat(new Uint8Array(req.data), req.elements === true);
    const transfer: Transferable[] = [flat.positions.buffer, flat.indices.buffer];
    if (flat.elementData) transfer.push(flat.elementData.buffer);
    return { res: { type: "result", flat }, transfer };
  } catch (err) {
    return { res: { type: "error", message: err instanceof Error ? err.message : String(err) }, transfer: [] };
  }
}

/** Liest im Web-Worker; `null`, wenn kein Worker verfügbar ist oder er nicht startet. */
function readInWorker(bytes: Uint8Array, elements: boolean): Promise<IfcFlat | null> {
  if (typeof Worker === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./ifcImport.worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(null);
      return;
    }
    worker.onmessage = (e: MessageEvent<IfcWorkerResponse>) => {
      worker.terminate();
      if (e.data?.type === "result") resolve(e.data.flat);
      else reject(new Error(e.data?.type === "error" ? e.data.message : "Unerwartete Worker-Antwort"));
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(null);
    };
    // Kopie übertragen: der Aufrufer behält seine Bytes.
    const data = bytes.slice().buffer;
    const req: IfcWorkerRequest = elements ? { type: "parse", data, elements } : { type: "parse", data };
    worker.postMessage(req, [data]);
  });
}

/** Rohergebnis → Bauteile (Ansichten in die flachen Puffer) + Bericht. */
export function decodeIfc(flat: IfcFlat): { products: IfcProduct[]; report: IfcImportReport } {
  const meta = JSON.parse(flat.meta) as Omit<IfcImportReport, "products"> & { products: RawProduct[] };
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
      positions: flat.positions.subarray(po, po + p.positionCount),
      indices: flat.indices.subarray(io, io + p.indexCount),
    });
    po += p.positionCount;
    io += p.indexCount;
  }
  return { products, report: { ...meta, products: products.length } };
}

/** Liest IFC-Bytes (im Worker, sonst direkt). Wirft bei unlesbarer Datei (Meldung aus Rust). */
export async function readIfc(bytes: Uint8Array): Promise<{ products: IfcProduct[]; report: IfcImportReport }> {
  return decodeIfc(await readIfcFlat(bytes));
}

/** Rohergebnis lesen (im Worker, sonst direkt); `elements` = echte Bauteile erkennen ([B4]). */
export async function readIfcFlat(bytes: Uint8Array, elements = false): Promise<IfcFlat> {
  return (await readInWorker(bytes, elements)) ?? (await importIfcFlat(bytes, elements));
}

/** RGBA 0..1 → `#rrggbb` (Alpha entfällt). */
export function ifcColorHex(c: readonly number[] | null | undefined): string | undefined {
  if (!c || c.length < 3 || !c.slice(0, 3).every((v) => Number.isFinite(v))) return undefined;
  return rgbToHex({ r: c[0] * 255, g: c[1] * 255, b: c[2] * 255 });
}

/** Ab so vielen Bauteilen wird je Klasse + Geschoss zusammengelegt. */
export const MAX_SINGLE = 2000;

export interface IfcToMeshesOptions {
  /** LV95-Ursprung des Projekts (`projectGeoOrigin`), sonst null. */
  geoOrigin?: { e: number; n: number } | null;
  /** "product" = je Bauteil, "class" = je Klasse + Geschoss, "auto" (Standard) nach `MAX_SINGLE`. */
  group?: "product" | "class" | "auto";
  /** Feste Verschiebung statt der aus den Bauteilen geschätzten ([B4]: gemeinsam mit den Bauteilen). */
  shift?: [number, number];
}

let counter = 0;

/** Verschiebung, falls die Datei in Landeskoordinaten liegt und das Projekt einen Bezug hat;
 *  `extra` = weitere Punkte (x,y flach, z. B. erkannte Bauteile [B4]). */
export function geoShift(
  products: IfcProduct[],
  origin: { e: number; n: number } | null | undefined,
  extra: readonly number[] = [],
): [number, number] {
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
  for (let i = 0; i + 1 < extra.length; i += 2) {
    sx += extra[i];
    sy += extra[i + 1];
    n++;
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
  const [dx, dy] = opts.shift ?? geoShift(products, opts.geoOrigin);
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
    return products.map((p) => {
      const color = ifcColorHex(p.color);
      return {
        id: `imported-ifc-${stamp}-${counter++}`,
        type: "importedMesh" as const,
        name: [p.storey, p.name || p.ifcClass].filter(Boolean).join(": "),
        layer: p.ifcClass,
        categoryCode: GENERIC_IMPORT_CATEGORY.code,
        ...(color ? { color } : {}),
        ...(p.globalId ? { ifcGlobalId: p.globalId } : {}),
        ...toArrays([p]),
      };
    });
  }
  const groups = new Map<string, IfcProduct[]>();
  for (const p of products) {
    const key = `${p.ifcClass}\u0000${p.storey ?? ""}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.values()].map((parts) => {
    // Gemeinsame Farbe nur, wenn alle Teile dieselbe haben.
    const colors = new Set(parts.map((p) => ifcColorHex(p.color) ?? ""));
    const color = colors.size === 1 ? [...colors][0] : "";
    return {
      id: `imported-ifc-${stamp}-${counter++}`,
      type: "importedMesh" as const,
      name: `${base}: ${[parts[0].storey, parts[0].ifcClass].filter(Boolean).join(" ")} (${parts.length})`,
      layer: parts[0].ifcClass,
      categoryCode: GENERIC_IMPORT_CATEGORY.code,
      ...(color ? { color } : {}),
      ...toArrays(parts),
    };
  });
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
