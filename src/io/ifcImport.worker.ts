// Web-Worker für den IFC-Import ([B3]): liest die Datei mit dem Format-Modul (`engine/fileioWasm.ts`)
// AUSSERHALB des Haupt-Threads, damit grosse Modelle die UI nicht einfrieren. Ein Worker je Aufruf,
// danach beendet (s. `ifcImport.ts::readIfcFlat`).
//
//   → { type: "parse", data: ArrayBuffer }
//   ← { type: "result", flat: { meta, positions, indices } } | { type: "error", message }
//
// Die beiden Puffer werden übertragen, nicht kopiert.

import { handleIfcWorkerRequest, type IfcWorkerRequest } from "./ifcImport";

self.onmessage = async (e: MessageEvent<IfcWorkerRequest>) => {
  const { res, transfer } = await handleIfcWorkerRequest(e.data);
  (self as unknown as Worker).postMessage(res, transfer);
};
