// Web-Worker-Einstiegspunkt für `parseDxf` — lagert die eigentliche Parse-
// Arbeit AUSSERHALB des Haupt-Threads aus, damit die UI bei sehr grossen
// Dateien (ein Kataster-DXF für eine ganze Stadt kann mehrere hundert MB mit
// Millionen Entities sein) nicht einfriert. `parseDxf` selbst ist komplett
// synchron (dxf-parser hat keine Chunk-/Progress-API) — bisher lief das direkt
// im Haupt-Thread (`useProjectFileActions.ts::openImportForFile`), was die App
// für die gesamte Parse-Dauer blockierte. Nutzer-Report 2026-10-08.
//
// Einfaches Einmal-Protokoll (ein Worker wird pro Import frisch erzeugt und
// danach terminiert, s. `dxfParserAsync.ts`):
//   → { type: "parse", text: string }
//   ← { type: "result", result: DxfImportResult } | { type: "error", message: string }
//
// `parseDxf` selbst ist "three-frei" (reine Datentransformation, keine DOM-
// Zugriffe) und läuft daher unverändert im Worker-Kontext — s. Kopfkommentar
// dort.

import { parseDxf } from "./dxfParser";
import type { DxfImportResult } from "./dxfParser";

export type DxfWorkerRequest = { type: "parse"; text: string };
export type DxfWorkerResponse =
  | { type: "result"; result: DxfImportResult }
  | { type: "error"; message: string };

self.onmessage = (e: MessageEvent<DxfWorkerRequest>) => {
  if (e.data?.type !== "parse") return;
  try {
    const result = parseDxf(e.data.text);
    const response: DxfWorkerResponse = { type: "result", result };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: DxfWorkerResponse = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
