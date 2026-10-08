// Asynchroner Wrapper um `parseDxf` über einen Web Worker
// (`dxfParser.worker.ts`) — hält den Haupt-Thread/die UI reaktionsfähig, auch
// bei sehr grossen DXF-Dateien (Kataster-Import einer ganzen Stadt, Nutzer-
// Report 2026-10-08: 400 MB liessen die App vorher für die GESAMTE Parse-
// Dauer einfrieren). Reiner Transport — die Parse-Logik bleibt unverändert
// in `dxfParser.ts` (dort weiterhin synchron direkt aufrufbar/testbar, z. B.
// für kleinere Importe oder Unit-Tests ohne Worker-Umgebung).
//
// Bewusst EIN Worker pro Import-Aufruf (nicht dauerhaft gepoolt) — DXF-Importe
// sind seltene, einmalige Aktionen, kein Hochfrequenz-Pfad; der Start-Overhead
// eines frischen Workers ist gegenüber der Parse-Dauer einer grossen Datei
// vernachlässigbar.
//
// `new Worker(new URL(...), { type: "module" })` ist Vites eingebautes Worker-
// Muster (funktioniert in Dev UND Build identisch, kein vite.config-Eintrag
// nötig) — kein Browser-Global, daher ohne dediziertes Unit-Test (Vitest läuft
// im "node"-Environment ohne `Worker`-Global, s. `vitest.config.ts`); dieselbe
// Bestes-Bemühen-Haltung wie bei anderem browser-API-gebundenem Code in diesem
// Projekt (z. B. `saveFile.ts`).

import type { DxfImportResult } from "./dxfParser";
import type { DxfWorkerRequest, DxfWorkerResponse } from "./dxfParser.worker";

export function parseDxfAsync(text: string): Promise<DxfImportResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dxfParser.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<DxfWorkerResponse>) => {
      worker.terminate();
      if (e.data.type === "result") resolve(e.data.result);
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "DXF-Import (Worker) fehlgeschlagen"));
    };
    const req: DxfWorkerRequest = { type: "parse", text };
    worker.postMessage(req);
  });
}
