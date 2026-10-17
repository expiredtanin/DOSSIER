// Asynchroner Wrapper um `parseDxf` über Web Worker (`dxfParser.worker.ts`)
// — hält den Haupt-Thread/die UI reaktionsfähig, auch bei sehr grossen DXF-
// Dateien (Kataster-Import einer ganzen Stadt, Nutzer-Report 2026-10-08:
// 400 MB liessen die App vorher für die GESAMTE Parse-Dauer einfrieren).
//
// Seit Nutzer-Report 2026-10-09 ("dauert ewig trotz Worker") zusätzlich
// ECHT PARALLEL über mehrere Kerne: `dxf-parser` selbst ist ein einziger
// monolithischer synchroner Pass ohne Streaming-/Teilbereichs-API (ein
// Worker alleine nutzt also nur einen Kern). `dxfEntityChunker.ts` teilt die
// ENTITIES-Sektion VOR dem Parsen in sichere, für sich gültige Stücke auf;
// jedes Stück läuft in seinem eigenen Worker durch das UNVERÄNDERTE
// `parseDxf` — danach werden die Teilergebnisse zusammengeführt. Schlägt
// die Aufteilung nicht an (zu klein, kein Multi-Core, kaputtes/exotisches
// Format) oder schlägt ein Chunk-Worker fehl, fällt diese Funktion exakt auf
// den bisherigen Einzel-Worker-Weg zurück — Korrektheit (amtliche
// Vermessungsdaten!) geht vor Geschwindigkeit: im schlimmsten Fall nur
// langsam, nie falsch.
//
// Bewusst EIN Worker pro Chunk (nicht dauerhaft gepoolt) — DXF-Importe sind
// seltene, einmalige Aktionen, kein Hochfrequenz-Pfad; der Start-Overhead
// frischer Worker ist gegenüber der Parse-Dauer einer grossen Datei
// vernachlässigbar.
//
// `new Worker(new URL(...), { type: "module" })` ist Vites eingebautes Worker-
// Muster (funktioniert in Dev UND Build identisch, kein vite.config-Eintrag
// nötig) — kein Browser-Global, daher ohne dediziertes Unit-Test (Vitest läuft
// im "node"-Environment ohne `Worker`-Global, s. `vitest.config.ts`); dieselbe
// Bestes-Bemühen-Haltung wie bei anderem browser-API-gebundenem Code in diesem
// Projekt (z. B. `saveFile.ts`).

import type { ContourSet, ImportedMesh, ImportedText } from "../model/types";
import type { DxfImportResult } from "./dxfParser";
import type { DxfWorkerRequest, DxfWorkerResponse } from "./dxfParser.worker";
import { DXF_CHUNK_CLOSER, buildDxfChunks } from "./dxfEntityChunker";
import type { DxfSplitOffsets } from "./dxfEntityChunker";

/**
 * Höchstens so viele Worker gleichzeitig — bewusst NICHT `hardwareConcurrency`
 * direkt (Benchmark gegen die reale 439-MB-Kataster-Datei,
 * `scripts/bench-dxf-parallel.mjs`, auf einer Maschine mit 11 logischen
 * Kernen, davon 5 Performance-/6 Effizienzkerne): 4–5 parallele Worker
 * ergaben ~2,0–2,1× Speedup, 8 Worker nur ~1,4× — die zusätzlichen Worker
 * landen auf den deutlich langsameren Effizienzkernen und bremsen den
 * Durchschnitt, statt zu helfen. `navigator.hardwareConcurrency` kennt diese
 * Asymmetrie nicht (liefert nur die Gesamtzahl), daher ein fester, auf
 * gängigen Consumer-CPUs (Apple Silicon ebenso wie aktuelle Intel/AMD-
 * Hybridarchitekturen) breit funktionierender konservativer Deckel statt
 * eines Kernzahl-Vielfachen.
 */
const MAX_WORKERS = 4;

/** Spawnt einen frischen Worker für GENAU eine Anfrage; terminiert ihn danach. */
function runWorker(req: DxfWorkerRequest): Promise<DxfWorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dxfParser.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<DxfWorkerResponse>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "DXF-Import (Worker) fehlgeschlagen"));
    };
    worker.postMessage(req);
  });
}

async function runParseWorker(req: DxfWorkerRequest): Promise<DxfImportResult> {
  const res = await runWorker(req);
  if (res.type === "result") return res.result;
  throw new Error(res.type === "error" ? res.message : "Unerwartete Worker-Antwort");
}

/** Berechnet die Chunk-Grenzen in einem Worker (s. Kopfkommentar — der Scan
 *  allein braucht bei grossen Dateien Sekunden und darf die UI nicht blockieren). */
async function runSplitWorker(text: string, chunkCount: number): Promise<DxfSplitOffsets | null> {
  const res = await runWorker({ type: "split", text, chunkCount });
  if (res.type === "splitOffsets") return res.offsets;
  return null;
}

/** Führt die Teilergebnisse mehrerer Chunk-Worker zusammen. */
function mergeResults(results: DxfImportResult[]): DxfImportResult {
  const meshes: ImportedMesh[] = [];
  const contours: ContourSet[] = [];
  const texts: ImportedText[] = [];
  for (const r of results) {
    for (const m of r.meshes) meshes.push(m);
    for (const c of r.contours) contours.push(c);
    for (const t of r.texts ?? []) texts.push(t);
  }
  return { meshes, contours, texts };
}

/**
 * `onProgress` ist rein informativ (UI-Status, s. `ImportDialog.tsx`) — sie
 * bekommt grobe Phasennamen, keine Prozentzahl (dxf-parser hat keine
 * Fortschritts-API, s. o.; echte Prozente würden eine zweite, künstliche
 * Fortschrittsmessung erfordern, die den Code nur verkompliziert, ohne die
 * eigentliche Dauer zu verkürzen).
 */
export async function parseDxfAsync(
  text: string,
  onProgress?: (phase: string) => void,
): Promise<DxfImportResult> {
  const chunkCount = Math.min(
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4,
    MAX_WORKERS,
  );

  // Phase 1: Chunk-Grenzen finden — in einem Worker (s. `runSplitWorker`),
  // NIE im Haupt-Thread (das wäre derselbe UI-Freeze-Fehler nur verschoben).
  let offsets: DxfSplitOffsets | null = null;
  if (chunkCount > 1) {
    onProgress?.("structure");
    try {
      offsets = await runSplitWorker(text, chunkCount);
    } catch {
      offsets = null; // Split-Worker fehlgeschlagen → Einzel-Worker-Fallback.
    }
  }
  // Phase 2: billiges Slicing (reine String-Views, unbedenklich hier).
  const split = offsets ? buildDxfChunks(text, offsets) : null;
  if (!split) {
    onProgress?.("parse-single");
    return runParseWorker({ type: "parse", text });
  }

  try {
    onProgress?.(`parse-parallel:${split.chunks.length}`);
    const results = await Promise.all(
      split.chunks.map((chunk, i) =>
        runParseWorker({
          type: "parse",
          text: split.preamble + chunk + DXF_CHUNK_CLOSER,
          idPrefix: `c${i}-`,
        }),
      ),
    );
    return mergeResults(results);
  } catch {
    // Irgendein Chunk ist fehlgeschlagen (z. B. weil der Splitter bei einer
    // exotischen/kaputten Datei doch einen unsicheren Punkt gewählt hat) —
    // einmalig der bisherige, garantiert korrekte Einzel-Worker-Weg mit dem
    // kompletten Originaltext.
    onProgress?.("parse-single");
    return runParseWorker({ type: "parse", text });
  }
}
