// Asynchroner DXF-/DWG-Import über Web-Worker (`dxfParser.worker.ts`) — hält die UI reaktionsfähig,
// auch bei sehr grossen Dateien (Nutzer-Report 08.10.: 400-MB-Kataster-DXF fror die App ein).
//
// Grosse ASCII-DXF werden zusätzlich PARALLEL gelesen (Nutzer-Report 09.10.): ein Split-Worker
// sucht sichere Schnittstellen in der ENTITIES-Sektion (Rust `split.rs`), jedes Stück
// (Präambel + Entities + Abschluss) läuft in einem eigenen Worker, danach werden die Teilergebnisse
// zusammengeführt. Schlägt Aufteilung oder ein Stück fehl, wird die ganze Datei einmal am Stück
// gelesen — Korrektheit (amtliche Vermessungsdaten!) vor Geschwindigkeit. Binär-DXF und DWG werden
// nicht geteilt.
//
// Ohne `Worker` (Node: CLI, Tests) wird direkt im aufrufenden Thread gelesen.

import type { ContourSet, ImportedMesh, ImportedText } from "../model/types";
import { loadFileio } from "../engine/fileioWasm";
import { decodeImport, parseDxf } from "./dxfParser";
import type { DxfImportResult, ImportDiagnostics } from "./dxfParser";
import type { DxfWorkerRequest, DxfWorkerResponse } from "./dxfParser.worker";

/**
 * Höchstens so viele Worker gleichzeitig (Benchmark 439-MB-Kataster-DXF, 5 Performance- +
 * 6 Effizienzkerne: 4–5 Worker ≈ 2×, 8 Worker nur ≈ 1,4× — die zusätzlichen landen auf den
 * langsamen Kernen). Fester, konservativer Deckel statt eines Kernzahl-Vielfachen.
 */
const MAX_WORKERS = 4;
/** Ab dieser Grösse lohnt sich das Aufteilen (gleiche Schwelle wie `split.rs`). */
const MIN_SIZE_FOR_SPLIT = 4_000_000;
/** Abschluss jedes Stücks (wie `split.rs::CHUNK_CLOSER`). */
const CHUNK_CLOSER = new TextEncoder().encode("0\nENDSEC\n0\nEOF\n");

/** Spawnt einen frischen Worker für GENAU eine Anfrage; terminiert ihn danach. */
function runWorker(req: DxfWorkerRequest, transfer: Transferable[] = []): Promise<DxfWorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dxfParser.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<DxfWorkerResponse>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "DXF-Import (Worker) fehlgeschlagen"));
    };
    worker.postMessage(req, transfer);
  });
}

async function runParseWorker(data: ArrayBuffer, idPrefix: string, transfer: boolean): Promise<DxfImportResult> {
  const res = await runWorker({ type: "parse", data }, transfer ? [data] : []);
  if (res.type === "result") return decodeImport(res.geom, res.strings, idPrefix);
  throw new Error(res.type === "error" ? res.message : "Unerwartete Worker-Antwort");
}

/** Führt die Teilergebnisse mehrerer Stücke zusammen. */
function mergeResults(results: DxfImportResult[]): DxfImportResult {
  const meshes: ImportedMesh[] = [];
  const contours: ContourSet[] = [];
  const texts: ImportedText[] = [];
  const layerColors: Record<string, string> = {};
  const diagnostics: ImportDiagnostics = { entityCounts: {}, total: 0 };
  for (const r of results) {
    for (const m of r.meshes) meshes.push(m);
    for (const c of r.contours) contours.push(c);
    for (const t of r.texts ?? []) texts.push(t);
    // Jedes Stück trägt dieselbe Präambel (inkl. LAYER-Tabelle) — Vereinigung reicht.
    Object.assign(layerColors, r.layerColors);
    for (const [k, n] of Object.entries(r.diagnostics?.entityCounts ?? {})) {
      diagnostics.entityCounts[k] = (diagnostics.entityCounts[k] ?? 0) + n;
    }
    diagnostics.total += r.diagnostics?.total ?? 0;
  }
  return { meshes, contours, texts, layerColors, diagnostics, insUnits: results[0]?.insUnits, unitScale: results[0]?.unitScale };
}

function toArrayBuffer(data: string | ArrayBuffer): ArrayBuffer {
  if (typeof data !== "string") return data;
  const bytes = new TextEncoder().encode(data);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Stücke als eigene Puffer: Präambel + Entities-Ausschnitt + Abschluss. */
function buildChunks(bytes: Uint8Array, offsets: number[]): ArrayBuffer[] {
  const preamble = bytes.subarray(0, offsets[0]);
  const out: ArrayBuffer[] = [];
  for (let i = 0; i + 1 < offsets.length; i++) {
    const body = bytes.subarray(offsets[i], offsets[i + 1]);
    const chunk = new Uint8Array(preamble.length + body.length + CHUNK_CLOSER.length);
    chunk.set(preamble, 0);
    chunk.set(body, preamble.length);
    chunk.set(CHUNK_CLOSER, preamble.length + body.length);
    out.push(chunk.buffer);
  }
  return out;
}

/**
 * Liest eine DXF- oder DWG-Datei (Text oder Bytes) im Hintergrund. `onProgress` bekommt grobe
 * Phasennamen (`"structure"`, `"parse-single"`, `"parse-parallel:<N>"`, s. `ImportDialog.tsx`).
 */
export async function parseDxfAsync(
  data: string | ArrayBuffer,
  onProgress?: (phase: string) => void,
): Promise<DxfImportResult> {
  if (typeof Worker === "undefined") {
    await loadFileio();
    return parseDxf(data);
  }
  const buf = toArrayBuffer(data);
  const chunkCount = Math.min(
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4,
    MAX_WORKERS,
  );

  let offsets: number[] = [];
  if (chunkCount > 1 && buf.byteLength >= MIN_SIZE_FOR_SPLIT) {
    onProgress?.("structure");
    try {
      // Kopie an den Split-Worker (das Original bleibt für die Stücke/den Rückfall hier).
      const res = await runWorker({ type: "split", data: buf, chunkCount });
      if (res.type === "splitOffsets") offsets = res.offsets;
    } catch {
      offsets = [];
    }
  }
  if (offsets.length >= 3) {
    const chunks = buildChunks(new Uint8Array(buf), offsets);
    try {
      onProgress?.(`parse-parallel:${chunks.length}`);
      const results = await Promise.all(chunks.map((c, i) => runParseWorker(c, `c${i}-`, true)));
      return mergeResults(results);
    } catch {
      // Ein Stück ist fehlgeschlagen → einmal am Stück lesen (garantiert korrekt).
    }
  }
  onProgress?.("parse-single");
  return runParseWorker(buf, "", false);
}
