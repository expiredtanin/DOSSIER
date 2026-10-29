// Allgemeiner Mesh-Import als Kontext-Meshes ([B3]/[C11]): OBJ (+ MTL), STL, glTF/GLB, PLY mit Flächen —
// Nachbargebäude und Umgebungsmodelle aus SketchUp/Blender/Rhino, Möbel. Dünne Fassade über den Rust-Leser
// (`src-tauri/fileio/src/mesh_import.rs`, Modul `pkgFileIo`); hier nur Aufruf, Dekodierung der flachen Puffer
// und die Abbildung auf `ImportedMesh` (wie `ifcImport.ts`, Farbe im Feld `color`).
//
// Laden im Web-Worker (`meshImport.worker.ts`), Rückfall im aufrufenden Thread (Node: CLI, Tests).
//
// Achse und Einheit entscheidet Rust (glTF: Y-up, Meter; OBJ/STL/PLY: Wahl bzw. Erkennung); Ergebnis ist
// Modell-Meter mit Z = Höhe. Platzierung: "center" = Grundriss-Mitte auf den Projekt-Nullpunkt, Unterkante
// auf z = 0; "original" = Koordinaten der Datei (liegen sie in Landeskoordinaten und das Projekt hat einen
// Standort-Bezug: auf den Modell-Nullpunkt zurückgeschoben, wie beim IFC-Import).

import { loadFileio } from "../engine/fileioWasm";
import { GENERIC_IMPORT_CATEGORY } from "../model/contextCategories";
import type { ImportedMesh } from "../model/types";
import { rgbToHex } from "../model/color";

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
/** Ab so vielen Objekten wird je Gruppe + Farbe zusammengelegt (Projektdatei, Kontext-Panel). */
export const MAX_SINGLE = 2000;
/** Präfix des Rust-Fehlers für PLY ohne Flächen. */
export const NO_FACES_PREFIX = "[punktwolke]";
/** Präfix des Rust-Fehlers für fehlende externe glTF-Puffer. */
export const MISSING_EXTERNAL_PREFIX = "[extern]";

const FORMATS: readonly MeshFormat[] = ["obj", "stl", "gltf", "ply"];

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

/** Ein gelesenes Objekt (Modell-Meter, Z = Höhe). */
export interface MeshObject {
  name: string;
  group: string;
  /** sRGB 0..1 mit Alpha, falls die Datei eine Farbe hat. */
  color: [number, number, number, number] | null;
  positions: Float64Array;
  indices: Uint32Array;
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

const FLAT_VERSION = 1;
const HEAD = 12;

/** Flache Puffer → Objekte + Bericht (Aufbau: Kopf von `mesh_import.rs`). */
export function decodeMesh(r: MeshFlat): { objects: MeshObject[]; report: MeshImportReport } {
  const f = r.flat;
  if (f.length < HEAD || f[0] !== FLAT_VERSION) throw new Error("Mesh-Import: unbekannte Kodierung");
  const nWarn = f[10];
  const nObj = f[11];
  let at = HEAD;
  const warnings: string[] = [];
  for (let i = 0; i < nWarn; i++) warnings.push(r.strings[f[at++]] ?? "");
  const objects: MeshObject[] = [];
  for (let k = 0; k < nObj; k++) {
    const name = r.strings[f[at]] ?? "";
    const group = f[at + 1] >= 0 ? (r.strings[f[at + 1]] ?? "") : "";
    const color: MeshObject["color"] = f[at + 2] === 1 ? [f[at + 3], f[at + 4], f[at + 5], f[at + 6]] : null;
    const np = f[at + 7];
    const ni = f[at + 8];
    at += 9;
    if (!Number.isInteger(np) || !Number.isInteger(ni) || np < 0 || ni < 0 || at + np + ni > f.length) {
      throw new Error("Mesh-Import: Puffer beschädigt");
    }
    const positions = f.slice(at, at + np);
    at += np;
    const idx = f.subarray(at, at + ni);
    const indices = new Uint32Array(ni);
    for (let i = 0; i < ni; i++) indices[i] = idx[i];
    at += ni;
    objects.push({ name, group, color, positions, indices });
  }
  const report: MeshImportReport = {
    format: FORMATS[f[1]] ?? "obj",
    up: f[2] === 1 ? "y" : "z",
    upAuto: f[3] === 1,
    upCertain: f[4] === 1,
    unitScale: f[5],
    triangles: f[6],
    degenerate: f[7],
    badFaces: f[8],
    truncated: f[9] === 1,
    warnings,
    objects: objects.length,
  };
  return { objects, report };
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

/** Liest eine Mesh-Datei. Wirft mit der Meldung aus Rust bei unlesbaren Dateien. */
export async function readMesh(
  bytes: Uint8Array,
  name: string,
  opts?: MeshReadOptions,
): Promise<{ objects: MeshObject[]; report: MeshImportReport }> {
  return decodeMesh(await readMeshFlat(bytes, name, opts));
}

// ── Abbildung auf Kontext-Meshes ────────────────────────────────────────────

export interface MeshToContextOptions {
  placement?: MeshPlacement;
  /** LV95-Ursprung des Projekts (`projectGeoOrigin`), sonst null (nur bei "original"). */
  geoOrigin?: { e: number; n: number } | null;
  /** "object" = je Objekt, "merge" = je Gruppe + Farbe, "auto" (Standard) nach `MAX_SINGLE`. */
  group?: "object" | "merge" | "auto";
}

/** Verschiebung (x, y, z) je nach Platzierung. */
export function meshShift(objects: readonly MeshObject[], opts: MeshToContextOptions = {}): [number, number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  for (const o of objects) {
    const p = o.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2];
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 0];
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  if ((opts.placement ?? "center") === "center") return [-cx, -cy, -minZ];
  const origin = opts.geoOrigin;
  if (origin && Math.hypot(cx - origin.e, cy - origin.n) < Math.hypot(cx, cy)) return [-origin.e, -origin.n, 0];
  return [0, 0, 0];
}

/** sRGB 0..1 → `#rrggbb` (Alpha entfällt). */
export function meshColorHex(c: readonly number[] | null | undefined): string | undefined {
  if (!c || c.length < 3 || !c.slice(0, 3).every((v) => Number.isFinite(v))) return undefined;
  return rgbToHex({ r: c[0] * 255, g: c[1] * 255, b: c[2] * 255 });
}

let counter = 0;

/** Objekte → Kontext-Meshes (Kategorie „Situation" wie IFC/STEP; `layer` = Gruppe, sonst Dateiname). */
export function meshObjectsToImportedMeshes(objects: readonly MeshObject[], fileName: string, opts: MeshToContextOptions = {}): ImportedMesh[] {
  const base = fileName.replace(/\.[^.]+$/, "") || "Mesh";
  const [dx, dy, dz] = meshShift(objects, opts);
  const stamp = Date.now().toString(36);
  const group = opts.group ?? "auto";
  const merge = group === "merge" || (group === "auto" && objects.length > MAX_SINGLE);

  const toArrays = (parts: readonly MeshObject[]): { positions: number[]; indices: number[] } => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const p of parts) {
      const off = positions.length / 3;
      for (let i = 0; i + 2 < p.positions.length; i += 3) {
        positions.push(p.positions[i] + dx, p.positions[i + 1] + dy, p.positions[i + 2] + dz);
      }
      for (let i = 0; i < p.indices.length; i++) indices.push(p.indices[i] + off);
    }
    return { positions, indices };
  };

  if (!merge) {
    return objects.map((o, i) => {
      const color = meshColorHex(o.color);
      return {
        id: `imported-mesh-${stamp}-${counter++}`,
        type: "importedMesh" as const,
        name: o.name || `${base} ${i + 1}`,
        layer: o.group || base,
        categoryCode: GENERIC_IMPORT_CATEGORY.code,
        ...(color ? { color } : {}),
        ...toArrays([o]),
      };
    });
  }
  const groups = new Map<string, MeshObject[]>();
  for (const o of objects) {
    const key = `${o.group}\u0000${meshColorHex(o.color) ?? ""}`;
    const g = groups.get(key);
    if (g) g.push(o);
    else groups.set(key, [o]);
  }
  return [...groups.values()].map((parts) => {
    const color = meshColorHex(parts[0].color);
    const g = parts[0].group;
    return {
      id: `imported-mesh-${stamp}-${counter++}`,
      type: "importedMesh" as const,
      name: `${base}${g ? `: ${g}` : ""} (${parts.length})`,
      layer: g || base,
      categoryCode: GENERIC_IMPORT_CATEGORY.code,
      ...(color ? { color } : {}),
      ...toArrays(parts),
    };
  });
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
