// Web-Worker-Einstiegspunkt für `parseDxf` — lagert die eigentliche Parse-
// Arbeit AUSSERHALB des Haupt-Threads aus, damit die UI bei sehr grossen
// Dateien (ein Kataster-DXF für eine ganze Stadt kann mehrere hundert MB mit
// Millionen Entities sein) nicht einfriert. `parseDxf` selbst ist komplett
// synchron (dxf-parser hat keine Chunk-/Progress-API) — bisher lief das direkt
// im Haupt-Thread (`useProjectFileActions.ts::openImportForFile`), was die App
// für die gesamte Parse-Dauer blockierte. Nutzer-Report 2026-10-08.
//
// Zwei Nachrichtentypen (ein Worker wird pro Aufruf frisch erzeugt und danach
// terminiert, s. `dxfParserAsync.ts`):
//   → { type: "parse", text: string, idPrefix?: string }
//   ← { type: "result", result: DxfImportResult } | { type: "error", message: string }
//
//   → { type: "split", text: string, chunkCount: number }
//   ← { type: "splitOffsets", offsets: DxfSplitOffsets | null } | { type: "error", ... }
//
// `idPrefix` wird nur für die parallele Chunk-Variante gesetzt (mehrere
// Worker parsen gleichzeitig je einen Ausschnitt derselben Datei) — ohne
// Präfix würden gleichzeitig laufende Worker (je ein eigener JS-Realm, der
// modul-globale `importSeq`-Zähler in `dxfParser.ts` startet in jedem bei 0)
// kollidierende IDs erzeugen.
//
// `"split"` lagert das Finden sicherer Chunk-Grenzen selbst in einen Worker
// aus (Nutzer-Report 2026-10-09: der Scan allein braucht bei 439 MB ~2 s —
// im Haupt-Thread aufgerufen, friert genau DAS die UI wieder ein, obwohl das
// eigentliche Parsen längst im Worker läuft). `dxfParserAsync.ts` holt sich
// hier nur die Zahlen (Offsets, winziges Payload) und slict die eigentlichen
// Chunk-Strings billig selbst im Haupt-Thread (`buildDxfChunks`).
//
// `parseDxf` selbst ist "three-frei" (reine Datentransformation, keine DOM-
// Zugriffe) und läuft daher unverändert im Worker-Kontext — s. Kopfkommentar
// dort.

import { parseDxf } from "./dxfParser";
import type { DxfImportResult } from "./dxfParser";
import { computeDxfSplitOffsets } from "./dxfEntityChunker";
import type { DxfSplitOffsets } from "./dxfEntityChunker";

export type DxfWorkerRequest =
  | { type: "parse"; text: string; idPrefix?: string }
  | { type: "split"; text: string; chunkCount: number };
export type DxfWorkerResponse =
  | { type: "result"; result: DxfImportResult }
  | { type: "splitOffsets"; offsets: DxfSplitOffsets | null }
  | { type: "error"; message: string };

self.onmessage = (e: MessageEvent<DxfWorkerRequest>) => {
  try {
    if (e.data?.type === "parse") {
      const result = parseDxf(e.data.text, e.data.idPrefix);
      const response: DxfWorkerResponse = { type: "result", result };
      (self as unknown as Worker).postMessage(response);
    } else if (e.data?.type === "split") {
      const offsets = computeDxfSplitOffsets(e.data.text, e.data.chunkCount);
      const response: DxfWorkerResponse = { type: "splitOffsets", offsets };
      (self as unknown as Worker).postMessage(response);
    }
  } catch (err) {
    const response: DxfWorkerResponse = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
