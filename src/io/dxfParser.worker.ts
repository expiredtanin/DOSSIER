// Web-Worker für den DXF-/DWG-Import: lädt das Rust-Format-Modul (`engine/fileioWasm.ts`) und liest
// die Datei AUSSERHALB des Haupt-Threads, damit die UI auch bei sehr grossen Dateien (Kataster-DXF
// einer ganzen Stadt, mehrere hundert MB) flüssig bleibt. Ein Worker je Aufruf, danach beendet
// (s. `dxfParserAsync.ts`).
//
//   → { type: "parse", data: ArrayBuffer, layout?: string }   (layout = Papierbereich-Layout statt Modellraum)
//   ← { type: "result", geom: Float64Array, strings: string[] } | { type: "error", message }
//
//   → { type: "split", data: ArrayBuffer, chunkCount: number }
//   ← { type: "splitOffsets", offsets: number[] } | { type: "error", message }
//
// Zurück geht der flache Puffer (übertragen, nicht kopiert); `dxfParser.ts::decodeImport` baut
// daraus im Haupt-Thread das `DxfImportResult`. `"split"` sucht die sicheren Schnittstellen einer
// grossen ASCII-DXF (Rust `split.rs`) — der Scan allein dauert bei 400 MB spürbar und gehört
// daher ebenfalls in einen Worker.

import { loadFileio } from "../engine/fileioWasm";
import { importDrawingFlat } from "./dxfParser";

export type DxfWorkerRequest =
  | { type: "parse"; data: ArrayBuffer; layout?: string }
  | { type: "split"; data: ArrayBuffer; chunkCount: number };
export type DxfWorkerResponse =
  | { type: "result"; geom: Float64Array; strings: string[] }
  | { type: "splitOffsets"; offsets: number[] }
  | { type: "error"; message: string };

const post = (msg: DxfWorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<DxfWorkerRequest>) => {
  try {
    const m = await loadFileio();
    if (e.data?.type === "parse") {
      const { geom, strings } = importDrawingFlat(e.data.data, e.data.layout);
      post({ type: "result", geom, strings }, [geom.buffer]);
    } else if (e.data?.type === "split") {
      const offsets = Array.from(m.dxf_split_offsets(new Uint8Array(e.data.data), e.data.chunkCount));
      post({ type: "splitOffsets", offsets });
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
