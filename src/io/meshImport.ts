// Allgemeiner Mesh-Import als Kontext-Meshes ([B3]/[C11]): OBJ (+ MTL), STL, glTF/GLB, PLY mit Flächen —
// Nachbargebäude und Umgebungsmodelle aus SketchUp/Blender/Rhino, Möbel. Dünne Fassade über den Rust-Leser
// (`src-tauri/fileio/src/mesh_import.rs`, Modul `pkgFileIo`); hier nur der Aufruf. Bericht und Abbildung auf
// `ImportedMesh` (Farbe im Feld `color`, Platzierung, Gruppierung) liest der Kern aus den flachen Puffern
// (`core/src/import_context.rs`; Übernahme als EIN Undo-Schritt über `ProjectDocument.importMesh`, [K4] S4).
//
// Laden im Web-Worker (`meshImport.worker.ts`), Rückfall im aufrufenden Thread (Node: CLI, Tests).
//
// Achse und Einheit entscheidet Rust (glTF: Y-up, Meter; OBJ/STL/PLY: Wahl bzw. Erkennung); Ergebnis ist
// Modell-Meter mit Z = Höhe. Platzierung: "center" = Grundriss-Mitte auf den Projekt-Nullpunkt, Unterkante
// auf z = 0; "original" = Koordinaten der Datei (liegen sie in Landeskoordinaten und das Projekt hat einen
// Standort-Bezug: auf den Modell-Nullpunkt zurückgeschoben, wie beim IFC-Import).

import { loadFileio } from "../engine/fileioWasm";
import { core } from "../engine/coreWasm";

export type MeshUnit = "mm" | "cm" | "m" | "inch" | "foot";
export type MeshUp = "auto" | "z" | "y";
export type MeshPlacement = "center" | "original";
export type MeshFormat = "obj" | "stl" | "gltf" | "ply";

/** Meter je Einheit. */
export const MESH_UNIT_SCALE: Record<MeshUnit, number> = { mm: 0.001, cm: 0.01, m: 1, inch: 0.0254, foot: 0.3048 };
export const MESH_UNITS: readonly MeshUnit[] = ["mm", "cm", "m", "inch", "foot"];
/** Endungen der Hauptdateien (Menü, Drag & Drop); `mtl`/`bin` sind Begleitdateien. */
export const MESH_EXTENSIONS = ["obj", "stl", "gltf", "glb", "ply"] as const;
export const MESH_SIDECAR_EXTENSIONS = ["mtl", "bin"] as const;
/** Präfix des Rust-Fehlers für PLY ohne Flächen. */
export const NO_FACES_PREFIX = "[punktwolke]";
/** Präfix des Rust-Fehlers für fehlende externe glTF-Puffer. */
export const MISSING_EXTERNAL_PREFIX = "[extern]";

export function isMeshFile(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (MESH_EXTENSIONS as readonly string[]).includes(ext);
}

export function isMeshSidecar(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (MESH_SIDECAR_EXTENSIONS as readonly string[]).includes(ext);
}

export interface MeshReadOptions {
  unit?: MeshUnit;
  up?: MeshUp;
  /** Dreiecksgrenze (0/fehlt = Voreinstellung 6 Mio.). */
  maxTriangles?: number;
  /** Begleitdateien (`.mtl`, `.bin`). */
  files?: { name: string; bytes: Uint8Array }[];
}

export interface MeshImportReport {
  format: MeshFormat;
  /** Verwendete Achse. */
  up: "z" | "y";
  /** Achse wurde erkannt (nicht vorgegeben). */
  upAuto: boolean;
  /** Erkennung belastbar (Kopfkommentar oder eindeutige Ausdehnung). */
  upCertain: boolean;
  unitScale: number;
  triangles: number;
  degenerate: number;
  badFaces: number;
  truncated: boolean;
  warnings: string[];
  objects: number;
}

/** Rohergebnis aus Rust: Zahlenpuffer + Zeichenketten. */
export interface MeshFlat {
  flat: Float64Array;
  strings: string[];
}

/** Worker-Protokoll (`meshImport.worker.ts`). */
export type MeshWorkerRequest = {
  type: "parse";
  data: ArrayBuffer;
  name: string;
  unit: MeshUnit;
  up: MeshUp;
  maxTriangles: number;
  files: { name: string; data: ArrayBuffer }[];
};
export type MeshWorkerResponse = { type: "result"; flat: MeshFlat } | { type: "error"; message: string };

/** Bericht und Ausdehnung (Meter; `null` ohne Punkte) eines gelesenen Modells — der Kern liest den Puffer. */
export function meshReport(r: MeshFlat): { report: MeshImportReport; extent: [number, number, number] | null } {
  const out = core().mesh_import_report(r.flat, JSON.stringify(r.strings));
  if (out.startsWith("\u0001")) throw new Error(out.slice(1));
  return JSON.parse(out) as { report: MeshImportReport; extent: [number, number, number] | null };
}

/** Liest Mesh-Bytes mit dem geladenen Format-Modul (Worker oder aufrufender Thread). */
export async function importMeshFlat(
  bytes: Uint8Array,
  name: string,
  opts: Required<Pick<MeshReadOptions, "unit" | "up" | "maxTriangles">> & { files: { name: string; bytes: Uint8Array }[] },
): Promise<MeshFlat> {
  const m = await loadFileio();
  const sizes = opts.files.map((f) => f.bytes.length);
  const blob = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  let o = 0;
  for (const f of opts.files) {
    blob.set(f.bytes, o);
    o += f.bytes.length;
  }
  const r = m.import_mesh(
    bytes,
    name,
    MESH_UNIT_SCALE[opts.unit],
    opts.up === "z" ? 1 : opts.up === "y" ? 2 : 0,
    opts.maxTriangles,
    opts.files.map((f) => f.name),
    new Float64Array(sizes),
    blob,
  );
  try {
    return { flat: r.flat(), strings: r.strings() };
  } finally {
    r.free();
  }
}

function resolve(o: MeshReadOptions | undefined) {
  return {
    unit: o?.unit ?? "m",
    up: o?.up ?? "auto",
    maxTriangles: o?.maxTriangles && o.maxTriangles > 0 ? o.maxTriangles : 0,
    files: o?.files ?? [],
  };
}

/** Beantwortet eine Worker-Anfrage; liefert Antwort und zu übertragende Puffer. */
export async function handleMeshWorkerRequest(req: MeshWorkerRequest): Promise<{ res: MeshWorkerResponse; transfer: Transferable[] }> {
  try {
    if (req?.type !== "parse" || !(req.data instanceof ArrayBuffer)) throw new Error("ungültige Anfrage");
    const flat = await importMeshFlat(new Uint8Array(req.data), req.name, {
      unit: req.unit,
      up: req.up,
      maxTriangles: req.maxTriangles,
      files: (req.files ?? []).map((f) => ({ name: f.name, bytes: new Uint8Array(f.data) })),
    });
    return { res: { type: "result", flat }, transfer: [flat.flat.buffer] };
  } catch (err) {
    return { res: { type: "error", message: err instanceof Error ? err.message : String(err) }, transfer: [] };
  }
}

/** Liest im Web-Worker; `null`, wenn kein Worker verfügbar ist oder er nicht startet. */
function readInWorker(bytes: Uint8Array, name: string, o: ReturnType<typeof resolve>): Promise<MeshFlat | null> {
  if (typeof Worker === "undefined") return Promise.resolve(null);
  return new Promise((resolveP, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./meshImport.worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolveP(null);
      return;
    }
    worker.onmessage = (e: MessageEvent<MeshWorkerResponse>) => {
      worker.terminate();
      if (e.data?.type === "result") resolveP(e.data.flat);
      else reject(new Error(e.data?.type === "error" ? e.data.message : "Unerwartete Worker-Antwort"));
    };
    worker.onerror = () => {
      worker.terminate();
      resolveP(null);
    };
    // Kopien übertragen: der Aufrufer behält seine Bytes.
    const data = bytes.slice().buffer;
    const files = o.files.map((f) => ({ name: f.name, data: f.bytes.slice().buffer }));
    const req: MeshWorkerRequest = { type: "parse", data, name, unit: o.unit, up: o.up, maxTriangles: o.maxTriangles, files };
    worker.postMessage(req, [data, ...files.map((f) => f.data)]);
  });
}

/** Rohergebnis lesen (im Worker, sonst direkt). */
export async function readMeshFlat(bytes: Uint8Array, name: string, opts?: MeshReadOptions): Promise<MeshFlat> {
  const o = resolve(opts);
  return (await readInWorker(bytes, name, o)) ?? (await importMeshFlat(bytes, name, o));
}

/** Gelesene Mesh-Datei: Puffer (für den Import im Kern), Bericht, Ausdehnung. */
export interface MeshRead {
  flat: MeshFlat;
  report: MeshImportReport;
  extent: [number, number, number] | null;
}

/** Liest eine Mesh-Datei. Wirft mit der Meldung aus Rust bei unlesbaren Dateien. */
export async function readMesh(bytes: Uint8Array, name: string, opts?: MeshReadOptions): Promise<MeshRead> {
  const flat = await readMeshFlat(bytes, name, opts);
  return { flat, ...meshReport(flat) };
}

/** Bericht als kurzer Text; `tr` übersetzt (Kern kennt kein i18n, die Hülle reicht `t` herein). */
export function formatMeshReport(
  r: MeshImportReport,
  tr: (
    key: "mesh.import.done" | "mesh.import.up" | "mesh.import.upUncertain" | "mesh.import.dropped" | "mesh.import.truncated",
    vars?: Record<string, string | number>,
  ) => string,
): string {
  const parts = [tr("mesh.import.done", { n: r.objects, tris: r.triangles, format: r.format.toUpperCase() })];
  if (r.upAuto) parts.push(tr(r.upCertain ? "mesh.import.up" : "mesh.import.upUncertain", { axis: r.up.toUpperCase() }));
  const dropped = r.degenerate + r.badFaces;
  if (dropped) parts.push(tr("mesh.import.dropped", { n: dropped }));
  if (r.truncated) parts.push(tr("mesh.import.truncated"));
  return parts.join(" · ");
}
