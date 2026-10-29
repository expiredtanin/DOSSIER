// Asynchroner DXF-/DWG-Import über Web-Worker (`dxfParser.worker.ts`) — hält die UI reaktionsfähig,
// auch bei sehr grossen Dateien (Nutzer-Report 08.10.: 400-MB-Kataster-DXF fror die App ein).
//
// Grosse ASCII-DXF werden zusätzlich PARALLEL gelesen (Nutzer-Report 09.10.): ein Split-Worker
// sucht sichere Schnittstellen in der ENTITIES-Sektion (Rust `split.rs`), jedes Stück
// (Präambel + Entities + Abschluss) läuft in einem eigenen Worker, danach werden die Teilergebnisse
// im Kern zusammengeführt. Schlägt Aufteilung oder ein Stück fehl, wird die ganze Datei einmal am Stück
// gelesen — Korrektheit (amtliche Vermessungsdaten!) vor Geschwindigkeit. Binär-DXF und DWG werden
// nicht geteilt.
//
// Ohne `Worker` (Node: CLI, Tests) wird direkt im aufrufenden Thread gelesen.

import { loadFileio } from "../engine/fileioWasm";
import { parseDxf } from "./dxfParser";
import { parsedImport, type ImportChunk, type ParsedImport } from "./importSource";
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

async function runParseWorker(data: ArrayBuffer, transfer: boolean, layout?: string): Promise<ImportChunk> {
  const res = await runWorker({ type: "parse", data, layout }, transfer ? [data] : []);
  if (res.type === "result") return { geom: res.geom, strings: res.strings };
  throw new Error(res.type === "error" ? res.message : "Unerwartete Worker-Antwort");
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
 * Mit `layout` kommt das Papierbereich-Layout dieses Namens statt des Modellraums.
 */
export async function parseDxfAsync(
  data: string | ArrayBuffer,
  onProgress?: (phase: string) => void,
  layout?: string,
): Promise<ParsedImport> {
  if (typeof Worker === "undefined") {
    await loadFileio();
    return parseDxf(data, layout);
  }
  const buf = toArrayBuffer(data);
  const chunkCount = Math.min(
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4,
    MAX_WORKERS,
  );

  let offsets: number[] = [];
  // Ein Layout (Papierbereich) ist klein und wird immer am Stück gelesen.
  if (layout === undefined && chunkCount > 1 && buf.byteLength >= MIN_SIZE_FOR_SPLIT) {
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
      // Die Stücke führt der Kern zusammen (`import_drawing::merge`).
      return parsedImport(await Promise.all(chunks.map((c) => runParseWorker(c, true))));
    } catch {
      // Ein Stück ist fehlgeschlagen → einmal am Stück lesen (garantiert korrekt).
    }
  }
  onProgress?.("parse-single");
  return parsedImport([await runParseWorker(buf, false, layout)]);
}
