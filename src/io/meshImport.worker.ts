// Web-Worker für den Mesh-Import: liest die Datei mit dem Format-Modul (`engine/fileioWasm.ts`) AUSSERHALB
// des Haupt-Threads, damit grosse Modelle die UI nicht einfrieren. Ein Worker je Aufruf, danach beendet
// (s. `meshImport.ts::readInWorker`).
//
//   → { type: "parse", data, name, unit, up, maxTriangles, files }
//   ← { type: "result", flat: { flat, strings } } | { type: "error", message }
//
// Der Zahlenpuffer wird übertragen, nicht kopiert.

import { handleMeshWorkerRequest, type MeshWorkerRequest } from "./meshImport";

self.onmessage = async (e: MessageEvent<MeshWorkerRequest>) => {
  const { res, transfer } = await handleMeshWorkerRequest(e.data);
  (self as unknown as Worker).postMessage(res, transfer);
};
