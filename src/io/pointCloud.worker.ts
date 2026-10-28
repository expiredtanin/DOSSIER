// Web-Worker für den Punktwolken-Import: lädt das Rust-Format-Modul und liest die Datei AUSSERHALB
// des Haupt-Threads (Muster `dxfParser.worker.ts`). Ein Worker je Aufruf, danach beendet.
//
//   → { type: "read", data: ArrayBuffer, name: string, options?: PointCloudOptions }
//   ← { type: "result", cloud: PointCloudData } | { type: "error", message }
//
// Die Typed Arrays gehen übertragen (nicht kopiert) zurück.

import { loadFileio } from "../engine/fileioWasm";
import { readPointCloudFlat } from "./pointCloud";
import type { PointCloudData, PointCloudOptions } from "./pointCloud";

export type PointCloudWorkerRequest = { type: "read"; data: ArrayBuffer; name: string; options?: PointCloudOptions };
export type PointCloudWorkerResponse = { type: "result"; cloud: PointCloudData } | { type: "error"; message: string };

const post = (msg: PointCloudWorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<PointCloudWorkerRequest>) => {
  try {
    await loadFileio();
    if (e.data?.type !== "read") throw new Error("Unbekannte Anfrage");
    const cloud = readPointCloudFlat(e.data.data, e.data.name, e.data.options);
    const transfer: Transferable[] = [cloud.xyz.buffer];
    for (const a of [cloud.rgb, cloud.intensity, cloud.classification]) if (a) transfer.push(a.buffer);
    post({ type: "result", cloud }, transfer);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
