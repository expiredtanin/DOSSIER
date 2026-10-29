// IFC-Import ([B3] Kontext-Meshes, [B4] Bauteile): dünne Fassade über `import_ifc`/`import_ifc_elements` im
// Format-Modul (`src-tauri/fileio`, `ifc_import.rs`, `ifc_semantic.rs`). Die Umwandlung ins Projekt — je
// Bauteil ein `ImportedMesh` der Kontext-Schicht (GlobalId, Farbe, Klasse als `layer`; ab `MAX_SINGLE`
// Bauteilen je Klasse + Geschoss zusammengelegt) bzw. echte Wände, Öffnungen, Decken, Stützen, Räume — macht
// der Kern als EIN Undo-Schritt (`core/src/import_ifc.rs`, `ProjectDocument.importIfc`, [K4] S4).
//
// Lesen im Web-Worker (`ifcImport.worker.ts`), damit grosse Dateien die UI nicht blockieren: zurück
// kommen nur der JSON-Bericht und zwei flache Puffer (übertragen, nicht kopiert). Ohne `Worker` (Node:
// CLI, Tests) oder wenn der Worker nicht startet, wird im aufrufenden Thread gelesen.
//
// Koordinaten: Meter, Z = Höhe, unverändert aus der Datei — ausser die Datei liegt in
// Landeskoordinaten und das Projekt hat einen Standort-Bezug: dann schiebt der Kern auf den Modell-Nullpunkt
// zurück (Gegenstück zu `projectToWorldCoords` beim Export).

import { loadFileio } from "../engine/fileioWasm";

/** Klassifikation eines Bauteils (IfcClassificationReference), z. B. eBKP-H `C`. */
export interface IfcClassificationRef {
  /** Name des Systems (IfcClassification), z. B. `eBKP-H`; leer, wenn die Datei keines nennt. */
  system: string;
  code: string;
  name: string | null;
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

/** Rohergebnis aus Rust: Bericht (JSON) und alle Bauteile hintereinander in zwei flachen Puffern;
 *  mit `elements` dazu die Zahlen der erkannten Bauteile ([B4], `core/src/import_ifc.rs`). */
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

/** Rohergebnis lesen (im Worker, sonst direkt); `elements` = echte Bauteile erkennen ([B4]). */
export async function readIfcFlat(bytes: Uint8Array, elements = false): Promise<IfcFlat> {
  return (await readInWorker(bytes, elements)) ?? (await importIfcFlat(bytes, elements));
}

/** Was der Bauteil-Import übernommen hat (`import_ifc.rs`, Meldung und Tests). */
export interface IfcElementsSummary {
  walls: number;
  openings: number;
  ceilings: number;
  columns: number;
  rooms: number;
  /** Neu angelegte Geschosse. */
  floors: number;
  wallTypes: number;
  ceilingTypes: number;
  components: number;
  /** Bauteile als Kontext-Mesh. */
  meshes: number;
  /** Übernommene Bauteile und Meshes mit Klassifikation (eBKP-H …; nur Mesh-Namen tragen sie). */
  classified: number;
  /** Davon Kandidaten, die nicht sicher abbildbar waren. */
  kept: number;
}

/** IFC-Import als Ops im Kern ([K4] S4): Antwort von `ProjectDocument.importIfc`. */
export interface IfcImportResult {
  report: IfcImportReport & { byClass: Record<string, number>; triangles: number };
  summary: IfcElementsSummary | null;
  kept: Record<string, number>;
  contextObjects: number;
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

/** Meldung zum Bauteil-Import; `tr` übersetzt (Kern kennt kein i18n). */
export function formatIfcElementsSummary(
  s: IfcElementsSummary,
  r: IfcImportReport,
  tr: (key: "ifc.import.elements" | "ifc.import.kept" | "ifc.import.classified", vars?: Record<string, string | number>) => string,
): string {
  const parts = [
    tr("ifc.import.elements", {
      schema: r.schema || "IFC",
      walls: s.walls,
      openings: s.openings,
      ceilings: s.ceilings,
      columns: s.columns,
      rooms: s.rooms,
      floors: s.floors,
      meshes: s.meshes,
    }),
  ];
  if (s.kept) parts.push(tr("ifc.import.kept", { n: s.kept }));
  if (s.classified) parts.push(tr("ifc.import.classified", { n: s.classified }));
  return parts.join(" · ");
}
